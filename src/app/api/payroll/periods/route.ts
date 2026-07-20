import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/payroll/periods
 * Get all payroll periods.
 */
export async function GET() {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data, error } = await supabase
    .from("payroll_periods")
    .select("*")
    .order("period_start", { ascending: false })
    .limit(50);

  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ periods: data ?? [] });
}

/**
 * POST /api/payroll/periods
 * Create a payroll period (manager only).
 * Body: { period_start, period_end, pay_date, payment_template }
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "manager") {
    return Response.json({ error: "Only managers can create payroll periods." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("payroll_periods")
    .insert({
      period_start: body.period_start,
      period_end: body.period_end,
      pay_date: body.pay_date,
      payment_template: body.payment_template ?? "biweekly",
      status: "open",
    })
    .select("id")
    .single();

  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ id: data.id }, { status: 201 });
}

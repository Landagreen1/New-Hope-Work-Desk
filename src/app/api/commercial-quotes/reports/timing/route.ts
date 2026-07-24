import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/commercial-quotes/reports/timing
 * Returns timing metrics based on column_history for operational reports.
 * Excludes quote_intake from timing calculations.
 * Calculates:
 *  - Quote Speed: time from entering 'quoting' to leaving 'quoting'
 *  - Customer Decision Time: time from leaving 'quoting' to arriving at 'sold' or 'not_sold'
 *  - Overall Cycle: total from entering 'quoting' to final outcome
 */
export async function GET() {
  const supabase = await createClient();
  if (!supabase) {
    return Response.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  // Only managers/super_admin can view reports
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "manager" && profile?.role !== "super_admin") {
    return Response.json({ error: "Manager access required." }, { status: 403 });
  }

  // Fetch all quotes that have reached sold or not_sold (completed quotes)
  const { data: quotes, error: quotesError } = await supabase
    .from("commercial_quotes")
    .select(`
      id, business_name, board_column, assigned_to, coverage_type, sold_premium,
      created_at, column_entered_at,
      profiles!commercial_quotes_assigned_to_fkey(display_name, initials)
    `)
    .eq("is_deleted", false)
    .in("board_column", ["sold", "not_sold", "commission_approved", "commission_not_approved"]);

  if (quotesError) {
    return Response.json({ error: quotesError.message }, { status: 400 });
  }

  if (!quotes || quotes.length === 0) {
    return Response.json({ metrics: [], summary: { avgQuoteSpeed: 0, avgDecisionTime: 0, avgCycleTime: 0, total: 0 } });
  }

  // Fetch column history for these quotes
  const quoteIds = quotes.map((q) => q.id);
  const { data: history, error: historyError } = await supabase
    .from("commercial_quote_column_history")
    .select("quote_id, from_column, to_column, moved_at")
    .in("quote_id", quoteIds)
    .order("moved_at", { ascending: true });

  if (historyError) {
    return Response.json({ error: historyError.message }, { status: 400 });
  }

  // Group history by quote
  const historyByQuote = new Map<string, Array<{ from_column: string | null; to_column: string; moved_at: string }>>();
  for (const h of (history ?? [])) {
    if (!historyByQuote.has(h.quote_id)) historyByQuote.set(h.quote_id, []);
    historyByQuote.get(h.quote_id)!.push(h);
  }

  // Calculate timing for each quote
  interface QuoteMetric {
    id: string;
    business_name: string;
    assigned_to: string;
    agent_name: string;
    agent_initials: string;
    outcome: "sold" | "not_sold";
    coverage_type: string | null;
    sold_premium: number | null;
    quote_speed_hours: number | null; // time in 'quoting' column
    decision_time_hours: number | null; // time from leaving quoting to outcome
    cycle_time_hours: number | null; // total from entering quoting to outcome
    entered_quoting_at: string | null;
    left_quoting_at: string | null;
    reached_outcome_at: string | null;
  }

  const metrics: QuoteMetric[] = [];

  for (const quote of quotes) {
    const moves = historyByQuote.get(quote.id) ?? [];
    const outcome = ["sold", "commission_approved"].includes(quote.board_column) ? "sold" : "not_sold";

    // Find when card entered 'quoting'
    const enteredQuoting = moves.find((m) => m.to_column === "quoting");
    // Find when card left 'quoting'
    const leftQuoting = moves.find(
      (m) => m.from_column === "quoting" && m.to_column !== "quoting"
    );
    // Find when card reached sold or not_sold
    const reachedOutcome = moves.find(
      (m) => ["sold", "not_sold"].includes(m.to_column)
    );

    const enteredQuotingAt = enteredQuoting?.moved_at ?? null;
    const leftQuotingAt = leftQuoting?.moved_at ?? null;
    const reachedOutcomeAt = reachedOutcome?.moved_at ?? quote.column_entered_at;

    let quoteSpeedHours: number | null = null;
    let decisionTimeHours: number | null = null;
    let cycleTimeHours: number | null = null;

    if (enteredQuotingAt && leftQuotingAt) {
      quoteSpeedHours = (new Date(leftQuotingAt).getTime() - new Date(enteredQuotingAt).getTime()) / 3600000;
    }

    if (leftQuotingAt && reachedOutcomeAt) {
      decisionTimeHours = (new Date(reachedOutcomeAt).getTime() - new Date(leftQuotingAt).getTime()) / 3600000;
    }

    if (enteredQuotingAt && reachedOutcomeAt) {
      cycleTimeHours = (new Date(reachedOutcomeAt).getTime() - new Date(enteredQuotingAt).getTime()) / 3600000;
    }

    const profileData = (Array.isArray(quote.profiles) ? quote.profiles[0] : quote.profiles) as { display_name: string; initials: string } | null;

    metrics.push({
      id: quote.id,
      business_name: quote.business_name,
      assigned_to: quote.assigned_to,
      agent_name: profileData?.display_name ?? "Unknown",
      agent_initials: profileData?.initials ?? "?",
      outcome,
      coverage_type: quote.coverage_type,
      sold_premium: quote.sold_premium,
      quote_speed_hours: quoteSpeedHours,
      decision_time_hours: decisionTimeHours,
      cycle_time_hours: cycleTimeHours,
      entered_quoting_at: enteredQuotingAt,
      left_quoting_at: leftQuotingAt,
      reached_outcome_at: reachedOutcomeAt,
    });
  }

  // Calculate summary averages (only from quotes with data)
  const withQuoteSpeed = metrics.filter((m) => m.quote_speed_hours != null && m.quote_speed_hours >= 0);
  const withDecisionTime = metrics.filter((m) => m.decision_time_hours != null && m.decision_time_hours >= 0);
  const withCycleTime = metrics.filter((m) => m.cycle_time_hours != null && m.cycle_time_hours >= 0);

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const summary = {
    avgQuoteSpeed: avg(withQuoteSpeed.map((m) => m.quote_speed_hours!)),
    avgDecisionTime: avg(withDecisionTime.map((m) => m.decision_time_hours!)),
    avgCycleTime: avg(withCycleTime.map((m) => m.cycle_time_hours!)),
    total: metrics.length,
    withTimingData: withCycleTime.length,
    soldCount: metrics.filter((m) => m.outcome === "sold").length,
    notSoldCount: metrics.filter((m) => m.outcome === "not_sold").length,
  };

  return Response.json({ metrics, summary });
}

import { canManageCommercial } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/commercial-quotes/reports/commissions/export
 *
 * Exports a CSV with full commission details for all commercial quotes
 * in the sold, commission_approved, and commission_not_approved columns.
 *
 * Query params:
 *   - agent: profile id to filter by assigned agent
 *   - status: 'approved' | 'denied' | 'pending' to filter by commission status
 *
 * Authorization: manager or super_admin or commercial_supervisor only.
 */

const COVERAGE_LABELS: Record<string, string> = {
  gl: "GL",
  wc: "WC",
  umb: "UMB",
  gl_wc: "GL + WC",
  gl_wc_umb: "GL + WC + UMB",
  bop: "BOP",
  commercial_auto: "Commercial Auto",
  homeowners: "Homeowners",
  trucking: "Trucking",
  other: "Other",
};

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function formatDateForCsv(iso: string | null): string {
  if (!iso) return "";
  try {
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso);
    if (Number.isNaN(date.getTime())) return iso;
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const year = date.getFullYear();
    return `${month}/${day}/${year}`;
  } catch {
    return iso ?? "";
  }
}

function resolveCommissionStatus(
  commissionStatus: string | null,
  boardColumn: string,
): string {
  if (commissionStatus === "approved") return "Approved";
  if (commissionStatus === "denied") return "Denied";
  if (boardColumn === "commission_approved") return "Approved";
  if (boardColumn === "commission_not_approved") return "Denied";
  return "Pending";
}

function boardColumnLabel(col: string): string {
  const labels: Record<string, string> = {
    quote_intake: "Quote Intake",
    quoting: "Quoting",
    price_sent: "Price Sent",
    sold: "Sold",
    not_sold: "Not Sold",
    commission_approved: "Commission Approved",
    commission_not_approved: "Commission Not Approved",
    to_do: "To Do",
    archive: "Archive",
  };
  return labels[col] ?? col;
}

export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) {
    return Response.json(
      { error: "Supabase is not configured." },
      { status: 503 },
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile || !canManageCommercial(profile.role)) {
    return Response.json(
      { error: "Commercial management access required." },
      { status: 403 },
    );
  }

  const { searchParams } = new URL(request.url);
  const filterAgent = searchParams.get("agent") ?? "";
  const filterStatus = searchParams.get("status") ?? "";

  // Fetch quotes from the three commission-relevant columns
  let query = supabase
    .from("commercial_quotes")
    .select(
      `*,
      profiles!commercial_quotes_assigned_to_fkey(display_name, initials, role),
      decision_profile:profiles!commercial_quotes_commission_decision_by_fkey(display_name)`
    )
    .in("board_column", ["sold", "commission_approved", "commission_not_approved"])
    .eq("is_deleted", false)
    .is("migrated_to_specialty_at", null)
    .order("updated_at", { ascending: false });

  if (filterAgent) {
    query = query.eq("assigned_to", filterAgent);
  }

  const { data: quotes, error } = await query;

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Apply status filter in-memory (commission_status vs board_column logic)
  let filtered = quotes ?? [];
  if (filterStatus === "approved") {
    filtered = filtered.filter(
      (q) => q.commission_status === "approved" || q.board_column === "commission_approved",
    );
  } else if (filterStatus === "denied") {
    filtered = filtered.filter(
      (q) => q.commission_status === "denied" || q.board_column === "commission_not_approved",
    );
  } else if (filterStatus === "pending") {
    filtered = filtered.filter(
      (q) =>
        q.board_column === "sold" &&
        (!q.commission_status || q.commission_status === "pending"),
    );
  }

  // Build CSV rows
  const headers = [
    "Business Name",
    "Agent",
    "Board Column",
    "Commission Status",
    "Policy Number",
    "Coverage Type",
    "Risk Level",
    "Card Status",
    "Sold Premium",
    "Total Premium",
    "Sold Date",
    "Created Date",
    "Board Entered Date",
    "Column Entered Date",
    "Commission Decision Date",
    "Commission Decision By",
    "Commission Denial Reason",
    "Commission Notes",
    "Description",
  ];

  const rows = filtered.map((q) => {
    const agentName =
      (q.profiles as { display_name?: string } | null)?.display_name ?? "";
    const decisionByName =
      (q.decision_profile as { display_name?: string } | null)?.display_name ?? "";

    return [
      csvEscape(q.business_name),
      csvEscape(agentName),
      csvEscape(boardColumnLabel(q.board_column)),
      csvEscape(resolveCommissionStatus(q.commission_status, q.board_column)),
      csvEscape(q.policy_number),
      csvEscape(q.coverage_type ? COVERAGE_LABELS[q.coverage_type] ?? q.coverage_type : ""),
      csvEscape(q.risk_level),
      csvEscape(q.card_status),
      csvEscape(q.sold_premium != null ? q.sold_premium : ""),
      csvEscape(q.total_premium != null ? q.total_premium : ""),
      csvEscape(formatDateForCsv(q.sold_at)),
      csvEscape(formatDateForCsv(q.created_at)),
      csvEscape(formatDateForCsv(q.board_entered_at)),
      csvEscape(formatDateForCsv(q.column_entered_at)),
      csvEscape(formatDateForCsv(q.commission_decision_at)),
      csvEscape(decisionByName),
      csvEscape(q.commission_denial_reason),
      csvEscape(q.commission_notes),
      csvEscape(q.description),
    ].join(",");
  });

  // Assemble CSV with UTF-8 BOM for Excel compatibility
  const bom = "\uFEFF";
  const headerLine = headers.map(csvEscape).join(",");
  const csv = `${bom}${headerLine}\n${rows.join("\n")}\n`;

  const now = new Date();
  const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const filename = `commission-report-${datePart}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Export-Rows": String(filtered.length),
    },
  });
}

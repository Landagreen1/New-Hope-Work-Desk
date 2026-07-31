/**
 * Guards the migration SQL against silently drifting from the specification in
 * `rotation-engine.ts`.
 *
 * These are structural assertions on the SQL text, in the same style as the
 * existing source-inspection tests under `src/features/cs-intake/__tests__/`.
 * They cannot prove runtime behaviour — only a real database can — but they do
 * catch the exact regression that caused this incident: the wraparound predicate
 * migrating from ORDER BY into WHERE.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION = path.resolve(
  __dirname,
  "../../../../supabase/migrations/v1.8.7-fix-rotation-integrity.sql",
);

const sql = fs.readFileSync(MIGRATION, "utf-8");
const lower = sql.toLowerCase();

/** Strip `--` line comments so structural matching is not defeated by prose. */
function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      // Naive but sufficient here: no `--` appears inside a string literal in
      // this migration. Verified by the "no stray quotes" test below.
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

/** Comment-free, whitespace-collapsed form for robust structural assertions. */
function normalize(text: string): string {
  return stripComments(text).replace(/\s+/g, " ").trim().toLowerCase();
}

const codeOnly = stripComments(sql);
const codeOnlyLower = codeOnly.toLowerCase();

/**
 * Extract one `create or replace function public.<name>(...)` block, ending at
 * its own closing dollar-quote tag. Handles named tags like `$preflight$`.
 */
function functionBody(name: string): string {
  const start = lower.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} must be defined in the migration`).toBeGreaterThan(-1);

  // Find the opening dollar tag that begins the body, e.g. `as $$` or `as $x$`.
  const tagMatch = /\bas\s+(\$[a-z_]*\$)/i.exec(sql.slice(start));
  expect(tagMatch, `${name} must have a dollar-quoted body`).not.toBeNull();
  const tag = tagMatch![1];
  const bodyStart = start + tagMatch!.index + tagMatch![0].length;
  const end = sql.indexOf(tag, bodyStart);
  expect(end, `${name} body must be terminated by ${tag}`).toBeGreaterThan(bodyStart);
  return sql.slice(start, end + tag.length);
}

/** Statements at migration scope, i.e. outside every dollar-quoted body. */
function migrationScopeStatements(): string {
  let out = "";
  let i = 0;
  const text = codeOnly;
  while (i < text.length) {
    const open = /\$[a-z_]*\$/i.exec(text.slice(i));
    if (!open) {
      out += text.slice(i);
      break;
    }
    const openIdx = i + open.index;
    out += text.slice(i, openIdx);
    const tag = open[0];
    const close = text.indexOf(tag, openIdx + tag.length);
    if (close === -1) break;
    i = close + tag.length;
  }
  return out.toLowerCase();
}

describe("v1.8.7 migration: structural integrity", () => {
  it("is wrapped in a single transaction", () => {
    const code = codeOnlyLower.trim();
    expect(code.startsWith("begin;")).toBe(true);
    expect(code.endsWith("commit;")).toBe(true);
    // Exactly one transaction, no nested/duplicate control.
    expect(code.match(/^\s*begin;/gm) ?? []).toHaveLength(1);
    expect(code.match(/^\s*commit;/gm) ?? []).toHaveLength(1);
    expect(code).not.toMatch(/^\s*rollback;/m);
  });

  it("contains NO destructive statements anywhere", () => {
    expect(codeOnlyLower).not.toMatch(/\bdrop\s+table\b/);
    expect(codeOnlyLower).not.toMatch(/\btruncate\b/);
    expect(codeOnlyLower).not.toMatch(/\bdelete\s+from\b/);
    expect(codeOnlyLower).not.toMatch(/\bdrop\s+schema\b/);
    expect(codeOnlyLower).not.toMatch(/\bdrop\s+function\b/);
    expect(codeOnlyLower).not.toMatch(/\balter\s+table\b/);
  });

  it("performs NO data writes at migration scope (only inside functions)", () => {
    const scope = migrationScopeStatements();
    // Recovery happens via ensure_rotation_valid on next interaction, never by
    // rewriting live queue state during deploy.
    expect(scope).not.toMatch(/update\s+public\.rotation_state/);
    expect(scope).not.toMatch(/update\s+public\.profiles/);
    expect(scope).not.toMatch(/insert\s+into\s+public\.turn_events/);
    expect(scope).not.toMatch(/insert\s+into\s+public\.work_items/);
    // Migration scope should only contain DDL / grants / transaction control.
    expect(scope).toMatch(/create or replace function/);
    expect(scope).toMatch(/grant execute on function/);
  });

  it("has no unbalanced string literals that would break comment stripping", () => {
    // Guards the stripComments() assumption used by the other assertions.
    for (const [i, line] of codeOnly.split("\n").entries()) {
      const quotes = (line.match(/'/g) ?? []).length;
      expect(
        quotes % 2,
        `line ${i + 1} has an odd number of quotes: ${line.trim()}`,
      ).toBe(0);
    }
  });

  it("does not edit any historical migration (forward-only)", () => {
    const dir = path.resolve(__dirname, "../../../../supabase/migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(files).toContain("v1.8.7-fix-rotation-integrity.sql");
    // The two prior queue migrations must still exist untouched by name.
    expect(files).toContain("v1.8.5-fix-rotation-null-on-claim.sql");
    expect(files).toContain("v1.8.6-fix-queue-system-comprehensive.sql");
  });

  it("has a post-install verification block that fails loudly", () => {
    expect(lower).toContain("v1.8.7 verification failed");
    expect(lower).toMatch(/raise exception 'v1\.8\.7 verification failed/);
  });

  it("documents that 'ringcentral' is a legacy internal label, not an integration", () => {
    // Comment prose is line-wrapped with leading `--`, so match on the
    // whitespace-collapsed full text rather than raw.
    const prose = sql.replace(/^\s*--/gm, " ").replace(/\s+/g, " ").toLowerCase();
    expect(prose).toContain("legacy internal label");
    expect(prose).toContain("does not imply any external ringcentral integration");
    expect(prose).toContain("customer service intake queue");
  });
});

describe("v1.8.7: next_eligible_profile matches the corrected contract", () => {
  const body = functionBody("next_eligible_profile");
  const bodyLower = normalize(body);

  it("puts the wraparound comparison in ORDER BY (RC-1 fix)", () => {
    const orderByIdx = bodyLower.indexOf("order by");
    expect(orderByIdx).toBeGreaterThan(-1);
    const afterOrderBy = bodyLower.slice(orderByIdx);
    // The bucket expression must live after ORDER BY.
    expect(afterOrderBy).toMatch(/case .*> p_after_position .*then 0 else 1 end/);
  });

  it("does NOT filter on p_after_position in the WHERE clause (the regression shape)", () => {
    const whereIdx = bodyLower.indexOf("where");
    const orderByIdx = bodyLower.indexOf("order by");
    expect(whereIdx).toBeGreaterThan(-1);
    expect(orderByIdx).toBeGreaterThan(whereIdx);
    const whereClause = bodyLower.slice(whereIdx, orderByIdx);
    // This is precisely what production had and what must never come back.
    expect(whereClause).not.toContain("p_after_position");
  });

  it("guards against a null rotation position (RC-5)", () => {
    const whereIdx = bodyLower.indexOf("where");
    const orderByIdx = bodyLower.indexOf("order by");
    const whereClause = bodyLower.slice(whereIdx, orderByIdx);
    expect(whereClause).toMatch(/is not null/);
  });

  it("orders deterministically with an id tiebreaker (RC-5)", () => {
    const orderByIdx = bodyLower.indexOf("order by");
    const afterOrderBy = bodyLower.slice(orderByIdx);
    // The final sort key before LIMIT must be the primary key.
    expect(afterOrderBy).toMatch(/p\.id\s*limit 1/);
  });

  it("keeps rotation participation agent-only (approved decision 2)", () => {
    expect(bodyLower).toMatch(/p\.role\s*=\s*'agent'/);
    expect(bodyLower).not.toContain("sales_supervisor");
  });

  it("requires availability = 'available' and is_active", () => {
    expect(bodyLower).toMatch(/p\.is_active/);
    expect(bodyLower).toMatch(/p\.availability\s*=\s*'available'/);
  });

  it("covers all three rotation kinds", () => {
    expect(bodyLower).toContain("whatsapp_active");
    expect(bodyLower).toContain("ringcentral_active");
    expect(bodyLower).toContain("workload_active");
    expect(bodyLower).toContain("whatsapp_position");
    expect(bodyLower).toContain("ringcentral_position");
    expect(bodyLower).toContain("workload_position");
  });

  it("stays STABLE and SECURITY DEFINER with a pinned search_path", () => {
    expect(bodyLower).toContain("stable");
    expect(bodyLower).toContain("security definer");
    expect(bodyLower).toMatch(/set search_path\s*=\s*public/);
  });
});

describe("v1.8.7: advance_rotation guarantees", () => {
  const body = functionBody("advance_rotation").toLowerCase();

  it("never writes NULL while an eligible fallback or actor exists (invariant 10)", () => {
    expect(body).toMatch(/is_rotation_eligible\(p_fallback/);
    expect(body).toMatch(/is_rotation_eligible\(p_actor/);
  });

  it("writes exactly one turn_events row per call", () => {
    const inserts = body.match(/insert into public\.turn_events/g) ?? [];
    expect(inserts).toHaveLength(1);
  });

  it("updates exactly one rotation_state row, scoped by kind", () => {
    const updates = body.match(/update public\.rotation_state/g) ?? [];
    expect(updates).toHaveLength(1);
    expect(body).toMatch(/where kind = p_rotation/);
  });

  it("increments version exactly once", () => {
    const bumps = body.match(/version\s*=\s*version \+ 1/g) ?? [];
    expect(bumps).toHaveLength(1);
  });

  it("validates the action against the turn_events check constraint", () => {
    for (const action of ["claim", "pass", "manual_change", "auto_skip", "daily_start"]) {
      expect(body).toContain(`'${action}'`);
    }
  });

  it("explains an empty queue instead of writing a bare NULL", () => {
    expect(body).toContain("rotation_empty_reason");
  });
});

describe("v1.8.7: ensure_rotation_valid guarantees (RC-3)", () => {
  const body = functionBody("ensure_rotation_valid").toLowerCase();

  it("is a no-op when the current agent is still eligible", () => {
    expect(body).toMatch(/if v_current is not null and public\.is_rotation_eligible/);
    expect(body).toMatch(/return v_current;/);
  });

  it("resumes from the stale agent's position rather than restarting the queue", () => {
    expect(body).toContain("rotation_position_of");
  });

  it("accepts NULL only when no eligible agent exists (invariant 6)", () => {
    expect(body).toMatch(/if v_next is null then/);
    expect(body).toMatch(/if v_current is null then\s*return null;/);
  });

  it("touches only the rotation it was given", () => {
    // Every rotation_state UPDATE must be scoped by `where kind = p_rotation`.
    const statements = body
      .split(";")
      .map((s) => normalize(s))
      .filter((s) => s.includes("update public.rotation_state"));
    expect(statements.length).toBeGreaterThanOrEqual(2);
    for (const stmt of statements) {
      expect(stmt, `unscoped rotation_state update: ${stmt}`).toContain(
        "where kind = p_rotation",
      );
    }
  });
});

describe("v1.8.7: pass_my_turn (approved decision 3)", () => {
  const body = functionBody("pass_my_turn").toLowerCase();

  it("no longer raises 'No eligible next agent'", () => {
    expect(body).not.toContain("no eligible next agent");
  });

  it("passes itself as the fallback so a sole agent keeps the turn", () => {
    expect(body).toMatch(/p_fallback\s*=>\s*v_me\.id/);
  });

  it("still rejects workload passes (unchanged policy)", () => {
    expect(body).toMatch(/p_rotation = 'workload'/);
    expect(body).toContain("cannot be passed");
  });

  it("still requires a reason and records it", () => {
    expect(body).toContain("a pass reason is required");
    expect(body).toMatch(/p_reason\s*=>\s*btrim\(p_reason\)/);
  });

  it("records the action as 'pass'", () => {
    expect(body).toMatch(/p_action\s*=>\s*'pass'/);
  });

  it("locks the rotation row before validating ownership", () => {
    const lockIdx = body.indexOf("for update");
    const ownershipIdx = body.indexOf("belongs to another agent");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(ownershipIdx).toBeGreaterThan(lockIdx);
  });

  it("revalidates the caller's eligibility after locking", () => {
    expect(body).toMatch(/is_rotation_eligible\(v_me\.id, p_rotation\)/);
  });
});

describe("v1.8.7: set_my_availability recovery", () => {
  const body = functionBody("set_my_availability").toLowerCase();

  it("repairs a null or stale rotation when an agent becomes available (invariant 7)", () => {
    expect(body).toContain("ensure_rotation_valid");
  });

  it("uses the guarded advance when an agent leaves", () => {
    expect(body).toContain("advance_rotation");
  });

  it("still runs the daily reset first (unchanged)", () => {
    expect(body).toContain("ensure_daily_availability_reset");
  });

  it("locks all three rotations in a deterministic order", () => {
    expect(body).toMatch(/order by kind for update/);
  });

  it("only hands off rotations the agent actually holds", () => {
    expect(body).toMatch(/v_rotation\.current_profile_id = v_me\.id/);
  });
});

describe("v1.8.7: manager_set_rotation_eligibility recovers on BOTH branches (RC-3)", () => {
  const body = functionBody("manager_set_rotation_eligibility").toLowerCase();

  it("no longer gates repair behind 'if not p_active'", () => {
    const ensureIdx = body.indexOf("ensure_rotation_valid");
    expect(ensureIdx).toBeGreaterThan(-1);
    // The repair call must not sit inside a `not p_active` branch.
    const beforeEnsure = body.slice(0, ensureIdx);
    expect(beforeEnsure).not.toMatch(/if not p_active then[\s\S]*$/);
  });

  it("drops the 'v_next is not null and v_next <> p_profile_id' escape hatch", () => {
    expect(body).not.toMatch(/v_next is not null and v_next <> p_profile_id/);
  });

  it("still requires manager authorization and a reason", () => {
    expect(body).toContain("can_manage_sales");
    expect(body).toContain("a reason is required");
  });

  it("still writes an audit_log entry", () => {
    expect(body).toContain("rotation_eligibility_changed");
  });

  it("affects only the named rotation", () => {
    expect(body).toMatch(/ensure_rotation_valid\(p_rotation/);
  });
});

describe("v1.8.7: timed quote and Recover", () => {
  it("claim_timed_quote advances from the current agent and keeps them as fallback", () => {
    const body = functionBody("claim_timed_quote").toLowerCase();
    expect(body).toMatch(/p_after_position\s*=>\s*public\.rotation_position_of\(v_current\.id/);
    expect(body).toMatch(/p_fallback\s*=>\s*v_current\.id/);
    expect(body).toMatch(/p_action\s*=>\s*'claim'/);
  });

  it("steal_timed_quote (Recover) advances from the MISSED agent's position", () => {
    const body = functionBody("steal_timed_quote").toLowerCase();
    // This is the documented rule: only the missed agent's turn is consumed.
    expect(body).toMatch(/p_after_position\s*=>\s*public\.rotation_position_of\(v_current\.id/);
    expect(body).toMatch(/p_previous\s*=>\s*v_current\.id/);
  });

  it("Recover still enforces deadline, ownership and eligibility", () => {
    const body = functionBody("steal_timed_quote").toLowerCase();
    expect(body).toContain("still has time remaining");
    expect(body).toContain("use take timed quote instead");
    expect(body).toContain("no longer active");
    expect(body).toMatch(/v_me\.availability <> 'available'/);
  });

  it("each timed function writes exactly one turn event via advance_rotation", () => {
    for (const fn of ["claim_timed_quote", "steal_timed_quote"]) {
      const body = functionBody(fn).toLowerCase();
      expect(body.match(/insert into public\.turn_events/g) ?? []).toHaveLength(0);
      expect(body.match(/advance_rotation/g) ?? []).toHaveLength(1);
    }
  });
});

describe("v1.8.7: preserved authorization surface", () => {
  it("re-grants execute on every replaced function", () => {
    for (const sig of [
      "public.next_eligible_profile(public.rotation_kind, integer)",
      "public.pass_my_turn(public.rotation_kind, text)",
      "public.set_my_availability(public.availability_status)",
      "public.manager_set_rotation_eligibility(uuid, public.rotation_kind, boolean, text)",
      "public.claim_timed_quote(uuid)",
      "public.steal_timed_quote(uuid)",
    ]) {
      expect(lower).toContain(`grant execute on function ${sig.toLowerCase()}`);
    }
  });

  it("keeps the internal transition helpers out of reach of end users", () => {
    expect(lower).toMatch(/revoke all on function public\.advance_rotation[\s\S]*from public/);
    expect(lower).toMatch(/revoke all on function public\.ensure_rotation_valid[\s\S]*from public/);
    expect(lower).not.toMatch(
      /grant execute on function public\.advance_rotation[^;]*to[^;]*authenticated/,
    );
  });

  it("does not modify functions that must never move a rotation", () => {
    for (const fn of [
      "log_manual_quote",
      "log_manual_workload",
      "log_payment_v094",
      "manager_create_and_assign_quote_v094",
      "cs_intake_claim",
      "cs_intake_manager_assign",
      "cs_intake_convert",
      "workload_reassign",
      "workload_void",
    ]) {
      expect(lower).not.toContain(`create or replace function public.${fn}(`);
    }
  });

  it("does not touch the claim functions already fixed by v1.8.5", () => {
    // Those keep working: once the selector wraps correctly, their existing
    // coalesce(v_next, v_me.id) guard simply stops being reachable.
    for (const fn of [
      "claim_whatsapp_quote",
      "claim_ringcentral_quote",
      "claim_linked_workload_turn",
      "claim_unlinked_workload_turn",
      "take_quote_turn",
    ]) {
      expect(lower).not.toContain(`create or replace function public.${fn}(`);
    }
  });

  it("does not alter cs_intake_claim_ringcentral (already the correct atomic flow)", () => {
    expect(lower).not.toContain(
      "create or replace function public.cs_intake_claim_ringcentral(",
    );
  });
});

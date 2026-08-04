/**
 * Canonical rotation semantics for the three independent queue rotations.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORTANT — this module is a SPECIFICATION, not the runtime.
 *
 * The database is the only authoritative source of queue state. Nothing here
 * runs during a claim, a pass, or an availability change. This module exists so
 * that the required semantics are executable and property-testable, and so the
 * SQL in `supabase/migrations/v1.8.7-fix-rotation-integrity.sql` can be checked
 * for parity against a single written-down contract.
 *
 * The frontend MUST NOT call `nextEligibleProfile` to decide who is next.
 * See `.kiro/steering/queue-rotation.md` invariant 14.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * "RingCentral" is a legacy internal label for the Customer Service Intake
 * Queue rotation. It does not imply any external RingCentral integration, API
 * call, or dependency. It is named that way only because intake information
 * historically arrived through customer-service calls.
 */

export type RotationKind = "whatsapp" | "ringcentral" | "workload";

/**
 * Roles that participate in a normal rotation.
 *
 * Deliberately agent-only. `sales_supervisor` and `manager` may view rotation
 * state, monitor agents, and use override/manual-assignment tools, but must
 * never become the current rotation holder, influence the next-agent
 * calculation, claim a normal turn, or pass an agent's turn. If supervisors ever
 * need to provide queue coverage, add an explicit per-profile participation flag
 * rather than widening this set.
 */
export const ROTATION_ROLES = ["agent"] as const;
export type RotationRole = (typeof ROTATION_ROLES)[number];

export interface RotationProfile {
  id: string;
  role: string;
  isActive: boolean;
  /** 'available' | 'unavailable' | 'break' | ... */
  availability: string;
  whatsappActive: boolean;
  ringcentralActive: boolean;
  workloadActive: boolean;
  whatsappPosition: number | null;
  ringcentralPosition: number | null;
  workloadPosition: number | null;
  /**
   * Authorized to take walk-in intakes (`profiles.can_claim_walk_in`, v1.11.0).
   * Not part of rotation eligibility — a walk-in refusal happens before the
   * rotation is touched, so this never changes who holds a turn.
   */
  canClaimWalkIn?: boolean;
}

export function rotationEnabled(
  profile: RotationProfile,
  rotation: RotationKind,
): boolean {
  switch (rotation) {
    case "whatsapp":
      return profile.whatsappActive;
    case "ringcentral":
      return profile.ringcentralActive;
    case "workload":
      return profile.workloadActive;
  }
}

export function rotationPosition(
  profile: RotationProfile,
  rotation: RotationKind,
): number | null {
  switch (rotation) {
    case "whatsapp":
      return profile.whatsappPosition;
    case "ringcentral":
      return profile.ringcentralPosition;
    case "workload":
      return profile.workloadPosition;
  }
}

/**
 * The single eligibility predicate. Every consumer — the selector, the
 * "is the current agent still usable" check, and the diagnostic — must use
 * exactly this definition. Today the live database disagrees across those three
 * places, which is root cause RC-5.
 */
export function isEligible(
  profile: RotationProfile,
  rotation: RotationKind,
): boolean {
  return (
    profile.isActive &&
    profile.availability === "available" &&
    (ROTATION_ROLES as readonly string[]).includes(profile.role) &&
    rotationEnabled(profile, rotation) &&
    rotationPosition(profile, rotation) !== null
  );
}

export function eligibleAgents(
  profiles: readonly RotationProfile[],
  rotation: RotationKind,
): RotationProfile[] {
  return profiles.filter((p) => isEligible(p, rotation));
}

/**
 * CORRECTED selector. Mirrors the SQL:
 *
 *   WHERE  <eligibility>
 *   ORDER BY
 *     case when <pos> > p_after_position then 0 else 1 end,   -- wraparound
 *     <pos>,
 *     id                                                      -- deterministic
 *   LIMIT 1
 *
 * Contract:
 *  - returns the eligible agent with the smallest position strictly greater
 *    than `afterPosition`;
 *  - if none exists, WRAPS to the eligible agent with the smallest position;
 *  - if `afterPosition` is null, returns the lowest-positioned eligible agent;
 *  - returns null ONLY when the eligible set is empty;
 *  - with exactly one eligible agent, always returns that agent — including
 *    when that agent is the current holder (self-loop).
 */
export function nextEligibleProfile(
  profiles: readonly RotationProfile[],
  rotation: RotationKind,
  afterPosition: number | null,
): string | null {
  const candidates = eligibleAgents(profiles, rotation);
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => {
    const pa = rotationPosition(a, rotation) as number;
    const pb = rotationPosition(b, rotation) as number;

    // Wraparound bucket: 0 = "after me", 1 = "wrapped around".
    // A null afterPosition puts everyone in the same bucket, so the lowest
    // position wins — matching SQL, where `pos > NULL` is NULL (not true).
    const bucketA = afterPosition !== null && pa > afterPosition ? 0 : 1;
    const bucketB = afterPosition !== null && pb > afterPosition ? 0 : 1;
    if (bucketA !== bucketB) return bucketA - bucketB;

    if (pa !== pb) return pa - pb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // deterministic tiebreak
  });

  return sorted[0].id;
}

/**
 * The CURRENT LIVE (defective) selector, reproduced exactly so the diagnosis is
 * executable. Mirrors production SQL:
 *
 *   WHERE  <eligibility without the null-position guard>
 *     AND  <pos> > p_after_position      -- hard filter: wraparound destroyed
 *   ORDER BY <pos>
 *   LIMIT 1
 *
 * Present ONLY to prove root cause RC-1 in tests. Never call this in app code.
 */
export function nextEligibleProfileLiveBroken(
  profiles: readonly RotationProfile[],
  rotation: RotationKind,
  afterPosition: number | null,
): string | null {
  const candidates = profiles.filter((p) => {
    const pos = rotationPosition(p, rotation);
    // Live SQL has no `position is not null` guard; `null > x` is NULL in SQL,
    // which is not true, so such rows drop out here via the comparison below.
    const passesPosition =
      afterPosition === null || pos === null ? false : pos > afterPosition;
    return (
      p.isActive &&
      p.availability === "available" &&
      p.role === "agent" &&
      rotationEnabled(p, rotation) &&
      passesPosition
    );
  });
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort(
    (a, b) =>
      (rotationPosition(a, rotation) as number) -
      (rotationPosition(b, rotation) as number),
  );
  return sorted[0].id;
}

// ───────────────────────────────────────────────────────────────────────────────
// Advancement
// ───────────────────────────────────────────────────────────────────────────────

export type TurnAction =
  | "claim"
  | "pass"
  | "manual_change"
  | "auto_skip"
  | "daily_start";

export interface RotationState {
  kind: RotationKind;
  currentProfileId: string | null;
  version: number;
}

export interface TurnEvent {
  rotation: RotationKind;
  action: TurnAction;
  actorProfileId: string | null;
  previousProfileId: string | null;
  nextProfileId: string | null;
  workItemId?: string | null;
  reason?: string | null;
}

export interface AdvanceResult {
  state: RotationState;
  events: TurnEvent[];
  /** True when the turn returned to the actor because nobody else is eligible. */
  selfLoop: boolean;
}

/**
 * Resolve and apply one rotation transition.
 *
 * Mirrors the SQL helper `advance_rotation(...)`, which runs inside the caller's
 * transaction after `SELECT ... FROM rotation_state WHERE kind = $1 FOR UPDATE`.
 *
 * Guarantees:
 *  - exactly one turn_events row per call;
 *  - version incremented exactly once;
 *  - never writes null while the actor (or anyone) is still eligible;
 *  - only the named rotation is touched.
 */
export function advanceRotation(params: {
  state: RotationState;
  profiles: readonly RotationProfile[];
  actorId: string;
  afterPosition: number | null;
  action: TurnAction;
  workItemId?: string | null;
  reason?: string | null;
}): AdvanceResult {
  const { state, profiles, actorId, afterPosition, action, workItemId, reason } =
    params;

  let next = nextEligibleProfile(profiles, state.kind, afterPosition);
  let selfLoop = false;

  if (next === null) {
    // Invariant 10: if the actor is still eligible, the turn stays with them
    // rather than nulling the rotation.
    const actor = profiles.find((p) => p.id === actorId);
    if (actor && isEligible(actor, state.kind)) {
      next = actorId;
      selfLoop = true;
    }
  } else if (next === actorId) {
    selfLoop = true;
  }

  return {
    state: {
      kind: state.kind,
      currentProfileId: next,
      version: state.version + 1,
    },
    events: [
      {
        rotation: state.kind,
        action,
        actorProfileId: actorId,
        previousProfileId: state.currentProfileId,
        nextProfileId: next,
        workItemId: workItemId ?? null,
        reason: reason ?? null,
      },
    ],
    selfLoop,
  };
}

/**
 * Idempotent repair. Mirrors the SQL helper `ensure_rotation_valid(...)`.
 *
 * Satisfies invariants 5 and 7: a rotation whose current agent went ineligible,
 * or which is null while eligible agents exist, recovers automatically without
 * a manager repairing it by hand.
 *
 * Returns the unchanged state (and no events) when nothing needs fixing, so it
 * is safe to call at the start of every rotation-touching action.
 */
export function ensureRotationValid(params: {
  state: RotationState;
  profiles: readonly RotationProfile[];
  actorId?: string | null;
}): AdvanceResult {
  const { state, profiles, actorId } = params;
  const current = state.currentProfileId
    ? profiles.find((p) => p.id === state.currentProfileId)
    : undefined;

  const currentIsValid = Boolean(current && isEligible(current, state.kind));
  if (currentIsValid) {
    return { state, events: [], selfLoop: false };
  }

  // Resume from the stale agent's position when we know it, so the queue keeps
  // its place instead of restarting at position 1.
  const from = current ? rotationPosition(current, state.kind) : null;
  const next = nextEligibleProfile(profiles, state.kind, from);

  if (next === state.currentProfileId) {
    return { state, events: [], selfLoop: false };
  }

  if (next === null) {
    // Invariant 6: with no eligible agents, null is correct. Only emit an event
    // if we are actually changing something.
    if (state.currentProfileId === null) {
      return { state, events: [], selfLoop: false };
    }
    return {
      state: { ...state, currentProfileId: null, version: state.version + 1 },
      events: [
        {
          rotation: state.kind,
          action: "auto_skip",
          actorProfileId: actorId ?? null,
          previousProfileId: state.currentProfileId,
          nextProfileId: null,
          reason: emptyQueueReason(profiles, state.kind),
        },
      ],
      selfLoop: false,
    };
  }

  return {
    state: { ...state, currentProfileId: next, version: state.version + 1 },
    events: [
      {
        rotation: state.kind,
        action: "auto_skip",
        actorProfileId: actorId ?? null,
        previousProfileId: state.currentProfileId,
        nextProfileId: next,
        reason:
          state.currentProfileId === null
            ? "Empty queue recovered automatically when an eligible agent was available"
            : "Current agent was no longer eligible; advanced automatically",
      },
    ],
    selfLoop: false,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Diagnostics for the UI (display only)
// ───────────────────────────────────────────────────────────────────────────────

export type EmptyQueueReason =
  | "no_agents_assigned"
  | "all_unavailable"
  | "missing_positions"
  | "eligible_agents_exist";

/**
 * Explains WHY a rotation has no current agent, so the UI can stop showing one
 * generic "No agent available" string for every distinct cause.
 *
 * `eligible_agents_exist` means the pointer is null even though someone is
 * eligible — an internal inconsistency that `ensureRotationValid` should have
 * repaired. Surfacing it makes the bug visible instead of silent.
 */
export function classifyEmptyQueue(
  profiles: readonly RotationProfile[],
  rotation: RotationKind,
): EmptyQueueReason {
  if (eligibleAgents(profiles, rotation).length > 0) {
    return "eligible_agents_exist";
  }

  const enabled = profiles.filter(
    (p) =>
      p.isActive &&
      (ROTATION_ROLES as readonly string[]).includes(p.role) &&
      rotationEnabled(p, rotation),
  );
  if (enabled.length === 0) return "no_agents_assigned";

  const availableEnabled = enabled.filter(
    (p) => p.availability === "available",
  );
  if (availableEnabled.length === 0) return "all_unavailable";

  if (availableEnabled.every((p) => rotationPosition(p, rotation) === null)) {
    return "missing_positions";
  }
  return "all_unavailable";
}

const ROTATION_LABELS: Record<RotationKind, string> = {
  whatsapp: "WhatsApp",
  // Legacy internal key. User-facing name only — no external integration.
  ringcentral: "Customer Service Intake Queue",
  workload: "Additional Workload",
};

export function rotationLabel(rotation: RotationKind): string {
  return ROTATION_LABELS[rotation];
}

export function emptyQueueReason(
  profiles: readonly RotationProfile[],
  rotation: RotationKind,
): string {
  const reason = classifyEmptyQueue(profiles, rotation);
  const enabledCount = profiles.filter(
    (p) =>
      p.isActive &&
      (ROTATION_ROLES as readonly string[]).includes(p.role) &&
      rotationEnabled(p, rotation),
  ).length;

  switch (reason) {
    case "no_agents_assigned":
      return `No agents are assigned to the ${rotationLabel(rotation)} queue.`;
    case "all_unavailable":
      return `All ${enabledCount} ${rotationLabel(rotation)} agents are unavailable or on break.`;
    case "missing_positions":
      return `Agents are available but have no ${rotationLabel(rotation)} queue position set.`;
    case "eligible_agents_exist":
      return `Queue state is inconsistent: eligible ${rotationLabel(rotation)} agents exist but no agent holds the turn.`;
  }
}

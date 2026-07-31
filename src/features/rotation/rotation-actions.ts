/**
 * Executable model of the queue-consuming actions, mirroring the SQL functions
 * in `supabase/migrations/v1.8.7-fix-rotation-integrity.sql`.
 *
 * SPECIFICATION ONLY — see the header of `rotation-engine.ts`. The database
 * remains the sole authority for queue state; nothing here runs at request time.
 *
 * Each action models one PostgreSQL function body executing inside a single
 * transaction, after `SELECT ... FROM rotation_state WHERE kind = $1 FOR UPDATE`.
 * Errors model `raise exception`, which rolls the whole transaction back — so a
 * thrown error must leave the passed-in world untouched.
 *
 * "ringcentral" is the legacy internal key for the Customer Service Intake
 * Queue rotation. No external RingCentral integration is involved.
 */

import {
  advanceRotation,
  ensureRotationValid,
  isEligible,
  rotationPosition,
  type RotationKind,
  type RotationProfile,
  type RotationState,
  type TurnEvent,
} from "./rotation-engine";

export interface WorkItem {
  id: string;
  customerName: string;
  assignedProfileId: string;
  /** Distinguishes a queue claim from a manual entry for reporting/auditing. */
  assignmentMethod:
    | "whatsapp_turn"
    | "ringcentral_turn"
    | "workload_turn"
    | "manual_quote"
    | "manual_workload"
    | "payment_log";
  receivedThrough: string;
  workType: "new_quote" | "requote" | "activation" | "change";
  sourceIntakeId?: string | null;
}

export type IntakeStatus =
  | "draft"
  | "submitted"
  | "claimed"
  | "converted"
  | "returned"
  | "deleted";

export interface Intake {
  id: string;
  status: IntakeStatus;
  /** 'ringcentral' = came through the queue; 'manual' = manager/manually routed. */
  intakeChannel: "ringcentral" | "manual";
  claimedBy: string | null;
  workItemId: string | null;
}

/** Everything a transaction may read or write. */
export interface World {
  rotations: Record<RotationKind, RotationState>;
  profiles: RotationProfile[];
  workItems: WorkItem[];
  intakes: Intake[];
  turnEvents: TurnEvent[];
}

export function cloneWorld(w: World): World {
  return {
    rotations: {
      whatsapp: { ...w.rotations.whatsapp },
      ringcentral: { ...w.rotations.ringcentral },
      workload: { ...w.rotations.workload },
    },
    profiles: w.profiles.map((p) => ({ ...p })),
    workItems: w.workItems.map((i) => ({ ...i })),
    intakes: w.intakes.map((i) => ({ ...i })),
    turnEvents: w.turnEvents.map((e) => ({ ...e })),
  };
}

export class RotationError extends Error {}

/** Runs `fn` on a copy; on throw, the original world is returned unchanged. */
function transaction<T>(
  world: World,
  fn: (draft: World) => T,
): { world: World; result?: T; error?: RotationError } {
  const draft = cloneWorld(world);
  try {
    const result = fn(draft);
    return { world: draft, result };
  } catch (err) {
    if (err instanceof RotationError) return { world, error: err };
    throw err;
  }
}

function applyAdvance(
  draft: World,
  rotation: RotationKind,
  params: Omit<Parameters<typeof advanceRotation>[0], "state" | "profiles">,
) {
  const out = advanceRotation({
    state: draft.rotations[rotation],
    profiles: draft.profiles,
    ...params,
  });
  draft.rotations[rotation] = out.state;
  draft.turnEvents.push(...out.events);
  return out;
}

function applyEnsureValid(
  draft: World,
  rotation: RotationKind,
  actorId?: string | null,
) {
  const out = ensureRotationValid({
    state: draft.rotations[rotation],
    profiles: draft.profiles,
    actorId,
  });
  draft.rotations[rotation] = out.state;
  draft.turnEvents.push(...out.events);
  return out;
}

function requireCaller(draft: World, actorId: string, rotation: RotationKind) {
  const me = draft.profiles.find((p) => p.id === actorId);
  if (!me || !me.isActive) throw new RotationError("Active profile not found");
  if (me.role !== "agent") throw new RotationError("Agent permission required");
  if (!isEligible(me, rotation)) {
    throw new RotationError(
      `Set your status to Available and confirm you are enabled for this queue`,
    );
  }
  return me;
}

let seq = 0;
function newId(prefix: string) {
  seq += 1;
  return `${prefix}-${seq}`;
}
export function resetIds() {
  seq = 0;
}

// ───────────────────────────────────────────────────────────────────────────────
// Queue-consuming actions
// ───────────────────────────────────────────────────────────────────────────────

/** WhatsApp / Customer Service Intake Queue / Workload normal quote claim. */
export function claimQuoteTurn(
  world: World,
  opts: {
    actorId: string;
    rotation: RotationKind;
    customerName: string;
    workType: WorkItem["workType"];
  },
) {
  return transaction(world, (draft) => {
    const me = requireCaller(draft, opts.actorId, opts.rotation);
    applyEnsureValid(draft, opts.rotation, opts.actorId);

    const state = draft.rotations[opts.rotation];
    if (state.currentProfileId === null) {
      throw new RotationError("No agent currently holds this turn");
    }
    if (state.currentProfileId !== me.id) {
      throw new RotationError("This turn belongs to another agent");
    }

    const item: WorkItem = {
      id: newId("wi"),
      customerName: opts.customerName,
      assignedProfileId: me.id,
      assignmentMethod: `${opts.rotation}_turn` as WorkItem["assignmentMethod"],
      receivedThrough:
        opts.rotation === "whatsapp"
          ? "WhatsApp dealership"
          : opts.rotation === "ringcentral"
            ? "Customer Service Intake Queue"
            : "Additional Workload",
      workType: opts.workType,
    };
    draft.workItems.push(item);

    applyAdvance(draft, opts.rotation, {
      actorId: me.id,
      afterPosition: rotationPosition(me, opts.rotation),
      action: "claim",
      workItemId: item.id,
    });
    return item;
  });
}

/**
 * Pass. Workload passes remain rejected by product policy (unchanged).
 * With one eligible agent the turn self-loops back to them rather than failing.
 */
export function passMyTurn(
  world: World,
  opts: { actorId: string; rotation: RotationKind; reason: string },
) {
  return transaction(world, (draft) => {
    if (opts.rotation === "workload") {
      throw new RotationError(
        "Additional Workload turns cannot be passed. Take the task and use Customer Service overflow after acceptance when needed.",
      );
    }
    if (!opts.reason.trim()) throw new RotationError("A pass reason is required");

    const me = requireCaller(draft, opts.actorId, opts.rotation);
    applyEnsureValid(draft, opts.rotation, opts.actorId);

    if (draft.rotations[opts.rotation].currentProfileId !== me.id) {
      throw new RotationError("This turn belongs to another agent");
    }

    const out = applyAdvance(draft, opts.rotation, {
      actorId: me.id,
      afterPosition: rotationPosition(me, opts.rotation),
      action: "pass",
      reason: opts.reason.trim(),
    });

    return {
      nextProfileId: out.state.currentProfileId,
      selfLoop: out.selfLoop,
      message: out.selfLoop
        ? "Pass recorded, but you remain current because no other eligible agent is available."
        : "Turn passed.",
    };
  });
}

/** Availability change. The only place that touches all three rotations. */
export function setMyAvailability(
  world: World,
  opts: { actorId: string; status: string },
) {
  return transaction(world, (draft) => {
    const me = draft.profiles.find((p) => p.id === opts.actorId);
    if (!me || !me.isActive) throw new RotationError("Active profile not found");
    if (me.role !== "agent") throw new RotationError("Agent permission required");

    me.availability = opts.status;

    // Deterministic order, matching `ORDER BY kind FOR UPDATE`.
    const kinds: RotationKind[] = ["ringcentral", "whatsapp", "workload"];
    for (const kind of kinds) {
      if (opts.status === "available") {
        // Repair a null or invalid pointer; if still empty, the newly available
        // agent starts the queue. Satisfies invariant 7.
        applyEnsureValid(draft, kind, me.id);
        if (
          draft.rotations[kind].currentProfileId === null &&
          isEligible(me, kind)
        ) {
          draft.rotations[kind] = {
            ...draft.rotations[kind],
            currentProfileId: me.id,
            version: draft.rotations[kind].version + 1,
          };
          draft.turnEvents.push({
            rotation: kind,
            action: "daily_start",
            actorProfileId: me.id,
            previousProfileId: null,
            nextProfileId: me.id,
            reason: "First eligible agent available started the queue",
          });
        }
      } else if (draft.rotations[kind].currentProfileId === me.id) {
        applyAdvance(draft, kind, {
          actorId: me.id,
          afterPosition: rotationPosition(me, kind),
          action: "auto_skip",
          reason: "Agent became unavailable",
        });
      }
    }
  });
}

/** Manager removes an agent from, or restores them to, one rotation. */
export function managerSetRotationEligibility(
  world: World,
  opts: {
    actorId: string;
    targetId: string;
    rotation: RotationKind;
    active: boolean;
    reason: string;
  },
) {
  return transaction(world, (draft) => {
    if (!opts.reason.trim()) throw new RotationError("A reason is required");
    const target = draft.profiles.find((p) => p.id === opts.targetId);
    if (!target) throw new RotationError("Active agent not found");

    if (opts.rotation === "whatsapp") target.whatsappActive = opts.active;
    else if (opts.rotation === "ringcentral") target.ringcentralActive = opts.active;
    else target.workloadActive = opts.active;

    // Runs on BOTH branches. Removing the current agent advances off them;
    // restoring an agent recovers a null/invalid rotation. Fixes RC-3.
    applyEnsureValid(draft, opts.rotation, opts.actorId);
  });
}

/** Manager pauses/reactivates an agent entirely. */
export function managerSetAgentActive(
  world: World,
  opts: { actorId: string; targetId: string; isActive: boolean },
) {
  return transaction(world, (draft) => {
    const target = draft.profiles.find((p) => p.id === opts.targetId);
    if (!target) throw new RotationError("Agent not found");
    target.isActive = opts.isActive;

    for (const kind of ["ringcentral", "whatsapp", "workload"] as RotationKind[]) {
      applyEnsureValid(draft, kind, opts.actorId);
    }
  });
}

/**
 * Customer Service Intake Queue claim — the one authoritative atomic workflow.
 * Models `cs_intake_claim_ringcentral(uuid)`.
 *
 * Claims the intake, converts it into the normal work item, assigns it to the
 * claiming agent, marks it as a queue-turn assignment, advances the rotation
 * exactly once, and is idempotent on retry.
 */
export function claimIntakeThroughQueue(
  world: World,
  opts: { actorId: string; intakeId: string },
) {
  return transaction(world, (draft) => {
    const intake = draft.intakes.find((i) => i.id === opts.intakeId);
    if (!intake) throw new RotationError("Intake not found");

    // Idempotency FIRST, before any eligibility check: a retry after a
    // successful commit must return the existing work item even if the turn has
    // since moved on.
    if (intake.status === "converted" && intake.workItemId) {
      if (intake.claimedBy === opts.actorId) return intake.workItemId;
      throw new RotationError("This intake was already converted by another agent");
    }

    if (intake.intakeChannel !== "ringcentral") {
      throw new RotationError(
        "This intake is manager/manually assigned and does not use the queue turn",
      );
    }

    const recovering =
      intake.status === "claimed" &&
      intake.claimedBy === opts.actorId &&
      intake.workItemId === null;

    if (!recovering && intake.status !== "submitted") {
      throw new RotationError("This intake is no longer available to claim");
    }

    const me = requireCaller(draft, opts.actorId, "ringcentral");
    applyEnsureValid(draft, "ringcentral", opts.actorId);

    if (draft.rotations.ringcentral.currentProfileId !== me.id) {
      throw new RotationError("This queue turn belongs to another agent");
    }

    intake.status = "claimed";
    intake.claimedBy = me.id;

    const item: WorkItem = {
      id: newId("wi"),
      customerName: `intake-${intake.id}`,
      assignedProfileId: me.id,
      assignmentMethod: "ringcentral_turn",
      receivedThrough: "Customer Service Intake Queue",
      workType: "new_quote",
      sourceIntakeId: intake.id,
    };
    draft.workItems.push(item);

    intake.status = "converted";
    intake.workItemId = item.id;

    applyAdvance(draft, "ringcentral", {
      actorId: me.id,
      afterPosition: rotationPosition(me, "ringcentral"),
      action: "claim",
      workItemId: item.id,
      reason: "Customer Service intake claimed and converted",
    });

    return item.id;
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// Non-consuming actions — must NEVER move a rotation
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Manual quote or requote. A first-class parallel workflow, not a fallback.
 *
 * Deliberately does NOT require an intake, does NOT check turn ownership, and
 * does NOT advance any rotation. Records the real source so it stays
 * distinguishable from a queue claim in reporting.
 */
export function logManualQuote(
  world: World,
  opts: {
    actorId: string;
    customerName: string;
    workType: "new_quote" | "requote";
    receivedThrough: string;
  },
) {
  return transaction(world, (draft) => {
    const me = draft.profiles.find((p) => p.id === opts.actorId);
    if (!me || !me.isActive) throw new RotationError("Active profile not found");
    if (!opts.customerName.trim()) {
      throw new RotationError("Customer name is required");
    }
    if (!opts.receivedThrough.trim()) {
      throw new RotationError("Record where this quote came from");
    }

    const item: WorkItem = {
      id: newId("wi"),
      customerName: opts.customerName,
      assignedProfileId: me.id,
      assignmentMethod: "manual_quote",
      receivedThrough: opts.receivedThrough,
      workType: opts.workType,
    };
    draft.workItems.push(item);
    return item;
  });
}

/** Manager/manual intake assignment. Never consumes the queue turn. */
export function managerAssignIntake(
  world: World,
  opts: { actorId: string; intakeId: string; targetAgentId: string },
) {
  return transaction(world, (draft) => {
    const intake = draft.intakes.find((i) => i.id === opts.intakeId);
    if (!intake) throw new RotationError("Intake not found");
    if (intake.status !== "submitted") {
      throw new RotationError("This intake is no longer available for assignment");
    }
    const target = draft.profiles.find((p) => p.id === opts.targetAgentId);
    if (!target || !target.isActive) {
      throw new RotationError("Choose an active Sales Agent");
    }
    intake.status = "claimed";
    intake.claimedBy = opts.targetAgentId;
    intake.intakeChannel = "manual";
  });
}

export function logManualWorkload(
  world: World,
  opts: { actorId: string; customerName: string },
) {
  return transaction(world, (draft) => {
    const me = draft.profiles.find((p) => p.id === opts.actorId);
    if (!me || !me.isActive) throw new RotationError("Active profile not found");
    draft.workItems.push({
      id: newId("wi"),
      customerName: opts.customerName,
      assignedProfileId: me.id,
      assignmentMethod: "manual_workload",
      receivedThrough: "Manual workload",
      workType: "change",
    });
  });
}

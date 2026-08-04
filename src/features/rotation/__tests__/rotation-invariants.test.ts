/**
 * Invariant + transition tests for queue-rotation-integrity.
 *
 * Covers the mandatory invariants and the approved decisions:
 *   - rotations are agent-only
 *   - Pass with one eligible agent is a self-loop, never a failure, never null
 *   - the Customer Service Intake Queue claim is one atomic workflow
 *   - manual quote / requote remains a parallel first-class workflow
 */
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import {
  claimIntakeThroughQueue,
  claimQuoteTurn,
  cloneWorld,
  logManualQuote,
  logManualWorkload,
  managerAssignIntake,
  managerSetAgentActive,
  managerSetRotationEligibility,
  passMyTurn,
  resetIds,
  setMyAvailability,
  type World,
} from "../rotation-actions";
import {
  classifyEmptyQueue,
  eligibleAgents,
  isEligible,
  type RotationKind,
  type RotationProfile,
} from "../rotation-engine";

const ROTATIONS: RotationKind[] = ["whatsapp", "ringcentral", "workload"];

function agent(
  id: string,
  position: number | null,
  overrides: Partial<RotationProfile> = {},
): RotationProfile {
  return {
    id,
    role: "agent",
    isActive: true,
    availability: "available",
    whatsappActive: true,
    ringcentralActive: true,
    workloadActive: true,
    whatsappPosition: position,
    ringcentralPosition: position,
    workloadPosition: position,
    ...overrides,
  };
}

function makeWorld(
  profiles: RotationProfile[],
  current: Partial<Record<RotationKind, string | null>> = {},
): World {
  const first = profiles.find((p) => p.isActive) ?? null;
  const pick = (k: RotationKind) =>
    k in current ? (current[k] ?? null) : (first?.id ?? null);
  return {
    rotations: {
      whatsapp: { kind: "whatsapp", currentProfileId: pick("whatsapp"), version: 1 },
      ringcentral: { kind: "ringcentral", currentProfileId: pick("ringcentral"), version: 1 },
      workload: { kind: "workload", currentProfileId: pick("workload"), version: 1 },
    },
    profiles,
    workItems: [],
    intakes: [],
    turnEvents: [],
  };
}

/** Assert only `changed` moved; the other two kept pointer AND version. */
function expectOnlyRotationChanged(
  before: World,
  after: World,
  changed: RotationKind,
) {
  for (const k of ROTATIONS) {
    if (k === changed) continue;
    expect(after.rotations[k].currentProfileId).toBe(
      before.rotations[k].currentProfileId,
    );
    expect(after.rotations[k].version).toBe(before.rotations[k].version);
  }
  expect(after.turnEvents.filter((e) => e.rotation !== changed)).toHaveLength(
    before.turnEvents.filter((e) => e.rotation !== changed).length,
  );
}

function expectNoRotationChanged(before: World, after: World) {
  for (const k of ROTATIONS) {
    expect(after.rotations[k].currentProfileId).toBe(
      before.rotations[k].currentProfileId,
    );
    expect(after.rotations[k].version).toBe(before.rotations[k].version);
  }
  expect(after.turnEvents).toHaveLength(before.turnEvents.length);
}

beforeEach(() => resetIds());

// ─── 1, 2, 3 eligible agents ────────────────────────────────────────────────

describe("claim advances exactly once for 1, 2 and 3 eligible agents", () => {
  it.each([1, 2, 3])("%i eligible agent(s)", (n) => {
    const profiles = Array.from({ length: n }, (_, i) =>
      agent(`a${i + 1}`, i + 1),
    );
    for (const rotation of ROTATIONS) {
      const before = makeWorld(profiles, { [rotation]: "a1" });
      const { world: after, error } = claimQuoteTurn(before, {
        actorId: "a1",
        rotation,
        customerName: "Test",
        workType: "new_quote",
      });

      expect(error).toBeUndefined();
      expect(after.workItems).toHaveLength(1);
      // Exactly one turn event (AC-12).
      expect(after.turnEvents).toHaveLength(1);
      expect(after.turnEvents[0]).toMatchObject({
        rotation,
        action: "claim",
        previousProfileId: "a1",
        nextProfileId: n === 1 ? "a1" : "a2",
      });
      expect(after.rotations[rotation].currentProfileId).toBe(
        n === 1 ? "a1" : "a2",
      );
      expect(after.rotations[rotation].version).toBe(2);
      expectOnlyRotationChanged(before, after, rotation);
    }
  });
});

// ─── Invariant 9: wraparound ────────────────────────────────────────────────

describe("invariant 9: wraparound from last position to first", () => {
  it("full cycle returns to the first agent and never nulls", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.constantFrom(...ROTATIONS),
        (n, rotation) => {
          const profiles = Array.from({ length: n }, (_, i) =>
            agent(`a${i + 1}`, i + 1),
          );
          let world = makeWorld(profiles, { [rotation]: "a1" });

          for (let step = 0; step < n * 2; step++) {
            const holder = world.rotations[rotation].currentProfileId;
            expect(holder).not.toBeNull();
            const res = claimQuoteTurn(world, {
              actorId: holder!,
              rotation,
              customerName: `c${step}`,
              workType: "new_quote",
            });
            expect(res.error).toBeUndefined();
            world = res.world;
          }
          // After 2n claims we are back at the start.
          expect(world.rotations[rotation].currentProfileId).toBe("a1");
          expect(world.turnEvents).toHaveLength(n * 2);
          expect(
            world.turnEvents.every((e) => e.nextProfileId !== null),
          ).toBe(true);
        },
      ),
      { numRuns: 120 },
    );
  });
});

// ─── Pass: approved decision 3 ──────────────────────────────────────────────

describe("Pass semantics (approved decision: self-loop with one eligible agent)", () => {
  it("one eligible agent: Pass succeeds as a self-loop and keeps them current", () => {
    for (const rotation of ["whatsapp", "ringcentral"] as RotationKind[]) {
      const before = makeWorld([agent("solo", 4)], { [rotation]: "solo" });
      const { world: after, result, error } = passMyTurn(before, {
        actorId: "solo",
        rotation,
        reason: "Current workload",
      });

      expect(error).toBeUndefined();
      expect(result?.selfLoop).toBe(true);
      expect(result?.message).toBe(
        "Pass recorded, but you remain current because no other eligible agent is available.",
      );
      expect(after.rotations[rotation].currentProfileId).toBe("solo");
      expect(after.rotations[rotation].version).toBe(2); // incremented exactly once
      expect(after.turnEvents).toHaveLength(1);
      expect(after.turnEvents[0]).toMatchObject({
        rotation,
        action: "pass",
        previousProfileId: "solo",
        nextProfileId: "solo",
        reason: "Current workload",
      });
      expectOnlyRotationChanged(before, after, rotation);
    }
  });

  it("multiple agents: Pass moves to the next agent", () => {
    const before = makeWorld([agent("a", 1), agent("b", 2), agent("c", 3)], {
      whatsapp: "a",
    });
    const { world: after, result } = passMyTurn(before, {
      actorId: "a",
      rotation: "whatsapp",
      reason: "Busy",
    });
    expect(result?.selfLoop).toBe(false);
    expect(after.rotations.whatsapp.currentProfileId).toBe("b");
    expect(after.turnEvents).toHaveLength(1);
  });

  it("Pass records previous, next, actor, rotation and reason", () => {
    const before = makeWorld([agent("a", 1), agent("b", 2)], { whatsapp: "a" });
    const { world: after } = passMyTurn(before, {
      actorId: "a",
      rotation: "whatsapp",
      reason: "At capacity",
    });
    expect(after.turnEvents[0]).toEqual({
      rotation: "whatsapp",
      action: "pass",
      actorProfileId: "a",
      previousProfileId: "a",
      nextProfileId: "b",
      workItemId: null,
      reason: "At capacity",
    });
  });

  it("an ineligible caller cannot pass, and nothing changes", () => {
    const before = makeWorld([agent("a", 1, { availability: "break" }), agent("b", 2)], {
      whatsapp: "a",
    });
    const { world: after, error } = passMyTurn(before, {
      actorId: "a",
      rotation: "whatsapp",
      reason: "x",
    });
    expect(error).toBeDefined();
    expectNoRotationChanged(before, after);
  });

  it("a non-current agent cannot pass someone else's turn", () => {
    const before = makeWorld([agent("a", 1), agent("b", 2)], { whatsapp: "a" });
    const { world: after, error } = passMyTurn(before, {
      actorId: "b",
      rotation: "whatsapp",
      reason: "x",
    });
    expect(error?.message).toMatch(/belongs to another agent/i);
    expectNoRotationChanged(before, after);
  });

  it("workload Pass remains rejected (unchanged policy) and moves nothing", () => {
    const before = makeWorld([agent("a", 1), agent("b", 2)]);
    const { world: after, error } = passMyTurn(before, {
      actorId: "a",
      rotation: "workload",
      reason: "x",
    });
    expect(error?.message).toMatch(/cannot be passed/i);
    expectNoRotationChanged(before, after);
  });

  it("Pass requires a reason", () => {
    const before = makeWorld([agent("a", 1)], { whatsapp: "a" });
    const { error } = passMyTurn(before, {
      actorId: "a",
      rotation: "whatsapp",
      reason: "   ",
    });
    expect(error?.message).toMatch(/reason is required/i);
  });

  it("double-click Pass records two events but never nulls and never skips twice", () => {
    // Two agents: first pass a->b. The retry is rejected because a is no longer
    // current, so only ONE pass event exists.
    const before = makeWorld([agent("a", 1), agent("b", 2)], { whatsapp: "a" });
    const first = passMyTurn(before, {
      actorId: "a",
      rotation: "whatsapp",
      reason: "r",
    });
    const second = passMyTurn(first.world, {
      actorId: "a",
      rotation: "whatsapp",
      reason: "r",
    });
    expect(second.error?.message).toMatch(/belongs to another agent/i);
    expect(second.world.turnEvents).toHaveLength(1);
    expect(second.world.rotations.whatsapp.currentProfileId).toBe("b");
  });

  it("after a self-loop, a newly eligible agent receives the next turn", () => {
    let world = makeWorld([agent("solo", 1), agent("later", 2, { availability: "unavailable" })], {
      whatsapp: "solo",
    });
    const passed = passMyTurn(world, {
      actorId: "solo",
      rotation: "whatsapp",
      reason: "r",
    });
    expect(passed.result?.selfLoop).toBe(true);
    world = passed.world;

    // "later" comes back.
    world = setMyAvailability(world, { actorId: "later", status: "available" }).world;
    expect(eligibleAgents(world.profiles, "whatsapp")).toHaveLength(2);

    const next = passMyTurn(world, {
      actorId: "solo",
      rotation: "whatsapp",
      reason: "r",
    });
    expect(next.result?.selfLoop).toBe(false);
    expect(next.world.rotations.whatsapp.currentProfileId).toBe("later");
  });
});

// ─── Invariants 3, 5, 6, 7 ──────────────────────────────────────────────────

describe("invariants 3/5/6/7: null only when truly empty, and auto-recovery", () => {
  it("current agent going unavailable hands off, and only nulls when nobody is left", () => {
    let world = makeWorld([agent("a", 1), agent("b", 2)], {
      whatsapp: "a",
      ringcentral: "a",
      workload: "a",
    });

    world = setMyAvailability(world, { actorId: "a", status: "break" }).world;
    for (const k of ROTATIONS) {
      expect(world.rotations[k].currentProfileId).toBe("b");
    }

    world = setMyAvailability(world, { actorId: "b", status: "break" }).world;
    for (const k of ROTATIONS) {
      // Invariant 6: legitimately empty.
      expect(world.rotations[k].currentProfileId).toBeNull();
      expect(eligibleAgents(world.profiles, k)).toHaveLength(0);
      expect(classifyEmptyQueue(world.profiles, k)).toBe("all_unavailable");
    }

    // Invariant 7: first agent back recovers all three automatically.
    world = setMyAvailability(world, { actorId: "a", status: "available" }).world;
    for (const k of ROTATIONS) {
      expect(world.rotations[k].currentProfileId).toBe("a");
    }
  });

  it("all agents unavailable then one returns: no manual repair needed", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (n) => {
        const profiles = Array.from({ length: n }, (_, i) =>
          agent(`a${i + 1}`, i + 1, { availability: "unavailable" }),
        );
        let world = makeWorld(profiles, {
          whatsapp: null,
          ringcentral: null,
          workload: null,
        });
        const returning = `a${n}`;
        world = setMyAvailability(world, {
          actorId: returning,
          status: "available",
        }).world;
        for (const k of ROTATIONS) {
          expect(world.rotations[k].currentProfileId).toBe(returning);
        }
      }),
      { numRuns: 80 },
    );
  });

  it("a stale pointer at an ineligible agent is repaired on the next interaction", () => {
    // 'a' is unavailable but still recorded as current (the live corruption).
    const world = makeWorld(
      [agent("a", 1, { availability: "unavailable" }), agent("b", 2)],
      { whatsapp: "a" },
    );
    expect(isEligible(world.profiles[0], "whatsapp")).toBe(false);

    const { world: after, error } = claimQuoteTurn(world, {
      actorId: "b",
      rotation: "whatsapp",
      customerName: "C",
      workType: "new_quote",
    });
    expect(error).toBeUndefined();
    // Repair event + claim event.
    expect(after.turnEvents.map((e) => e.action)).toEqual(["auto_skip", "claim"]);
    expect(after.turnEvents[0].nextProfileId).toBe("b");
  });

  it("a null pointer with an eligible agent is repaired, not left broken", () => {
    const world = makeWorld([agent("a", 5)], { whatsapp: null });
    expect(classifyEmptyQueue(world.profiles, "whatsapp")).toBe(
      "eligible_agents_exist",
    );
    const { world: after, error } = claimQuoteTurn(world, {
      actorId: "a",
      rotation: "whatsapp",
      customerName: "C",
      workType: "new_quote",
    });
    expect(error).toBeUndefined();
    expect(after.rotations.whatsapp.currentProfileId).toBe("a");
  });

  it("no eligible agents at all: null is accepted and classified", () => {
    const world = makeWorld([agent("a", null)], { whatsapp: null });
    expect(eligibleAgents(world.profiles, "whatsapp")).toHaveLength(0);
    expect(classifyEmptyQueue(world.profiles, "whatsapp")).toBe(
      "missing_positions",
    );
  });

  it("no agents enabled for the rotation is distinguished from all unavailable", () => {
    const disabled = makeWorld([agent("a", 1, { whatsappActive: false })]);
    expect(classifyEmptyQueue(disabled.profiles, "whatsapp")).toBe(
      "no_agents_assigned",
    );
    const away = makeWorld([agent("a", 1, { availability: "break" })]);
    expect(classifyEmptyQueue(away.profiles, "whatsapp")).toBe("all_unavailable");
  });
});

// ─── Rotation removal / restore (RC-3) ──────────────────────────────────────

describe("RC-3: rotation removal and restore", () => {
  it("removing the current agent never leaves the rotation on them", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom(...ROTATIONS),
        (n, rotation) => {
          const profiles = Array.from({ length: n }, (_, i) =>
            agent(`a${i + 1}`, i + 1),
          );
          const before = makeWorld(profiles, { [rotation]: "a1" });
          const { world: after } = managerSetRotationEligibility(before, {
            actorId: "mgr",
            targetId: "a1",
            rotation,
            active: false,
            reason: "Coverage change",
          });
          expect(after.rotations[rotation].currentProfileId).not.toBe("a1");
          if (n === 1) {
            expect(after.rotations[rotation].currentProfileId).toBeNull();
          } else {
            expect(after.rotations[rotation].currentProfileId).toBe("a2");
          }
          expectOnlyRotationChanged(before, after, rotation);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("removing the ONLY eligible agent nulls the rotation instead of deadlocking on them", () => {
    const before = makeWorld([agent("solo", 1)], { whatsapp: "solo" });
    const { world: after } = managerSetRotationEligibility(before, {
      actorId: "mgr",
      targetId: "solo",
      rotation: "whatsapp",
      active: false,
      reason: "Paused",
    });
    // The live bug left it pointing at 'solo', who could no longer act.
    expect(after.rotations.whatsapp.currentProfileId).toBeNull();
    expect(after.turnEvents).toHaveLength(1);
  });

  it("restoring the only eligible agent to a NULL rotation recovers it (the live RC-3 bug)", () => {
    const before = makeWorld([agent("solo", 5, { whatsappActive: false })], {
      whatsapp: null,
    });
    const { world: after } = managerSetRotationEligibility(before, {
      actorId: "mgr",
      targetId: "solo",
      rotation: "whatsapp",
      active: true,
      reason: "Back on the queue",
    });
    expect(after.rotations.whatsapp.currentProfileId).toBe("solo");
    expect(after.turnEvents).toHaveLength(1);
    expectOnlyRotationChanged(before, after, "whatsapp");
  });

  it("restore only affects the named rotation", () => {
    const before = makeWorld(
      [agent("solo", 5, { whatsappActive: false, ringcentralActive: false })],
      { whatsapp: null, ringcentral: null, workload: "solo" },
    );
    const { world: after } = managerSetRotationEligibility(before, {
      actorId: "mgr",
      targetId: "solo",
      rotation: "whatsapp",
      active: true,
      reason: "r",
    });
    expect(after.rotations.whatsapp.currentProfileId).toBe("solo");
    expect(after.rotations.ringcentral.currentProfileId).toBeNull();
    expect(after.rotations.workload.currentProfileId).toBe("solo");
  });

  it("deactivating an agent hands off every rotation they held", () => {
    const before = makeWorld([agent("a", 1), agent("b", 2)], {
      whatsapp: "a",
      ringcentral: "a",
      workload: "a",
    });
    const { world: after } = managerSetAgentActive(before, {
      actorId: "mgr",
      targetId: "a",
      isActive: false,
    });
    for (const k of ROTATIONS) {
      expect(after.rotations[k].currentProfileId).toBe("b");
    }
  });
});

// ─── Concurrency / idempotency ──────────────────────────────────────────────

describe("invariants 12/13: idempotency and serialized concurrent claims", () => {
  it("two simultaneous claims: exactly one wins, rotation advances once", () => {
    const base = makeWorld([agent("a", 1), agent("b", 2)], { whatsapp: "a" });

    // Both read the same pre-advance state; the row lock serializes them.
    const first = claimQuoteTurn(base, {
      actorId: "a",
      rotation: "whatsapp",
      customerName: "C1",
      workType: "new_quote",
    });
    expect(first.error).toBeUndefined();

    const second = claimQuoteTurn(first.world, {
      actorId: "a",
      rotation: "whatsapp",
      customerName: "C2",
      workType: "new_quote",
    });
    expect(second.error?.message).toMatch(/belongs to another agent/i);

    expect(second.world.workItems).toHaveLength(1);
    expect(second.world.turnEvents.filter((e) => e.action === "claim")).toHaveLength(1);
    expect(second.world.rotations.whatsapp.currentProfileId).toBe("b");
  });

  it("two browser tabs double-clicking create one work item and one turn event", () => {
    const base = makeWorld([agent("a", 1), agent("b", 2), agent("c", 3)], {
      whatsapp: "a",
    });
    let world = base;
    let successes = 0;
    for (let i = 0; i < 5; i++) {
      const res = claimQuoteTurn(world, {
        actorId: "a",
        rotation: "whatsapp",
        customerName: "same-customer",
        workType: "new_quote",
      });
      if (!res.error) successes++;
      world = res.world;
    }
    expect(successes).toBe(1);
    expect(world.workItems).toHaveLength(1);
    expect(world.turnEvents).toHaveLength(1);
  });

  it("a failed claim leaves no work item and no turn event (atomicity)", () => {
    const before = makeWorld([agent("a", 1), agent("b", 2)], { whatsapp: "a" });
    const { world: after, error } = claimQuoteTurn(before, {
      actorId: "b", // not the current holder
      rotation: "whatsapp",
      customerName: "C",
      workType: "new_quote",
    });
    expect(error).toBeDefined();
    expect(after.workItems).toHaveLength(0);
    expect(after.turnEvents).toHaveLength(0);
    expectNoRotationChanged(before, after);
  });

  it("claim then availability change: the claimed rotation does not advance twice", () => {
    // 'a' holds ONLY whatsapp here, so going on break must move nothing else.
    const before = makeWorld([agent("a", 1), agent("b", 2), agent("c", 3)], {
      whatsapp: "a",
      ringcentral: "b",
      workload: "c",
    });
    const claimed = claimQuoteTurn(before, {
      actorId: "a",
      rotation: "whatsapp",
      customerName: "C",
      workType: "new_quote",
    });
    expect(claimed.world.rotations.whatsapp.currentProfileId).toBe("b");
    expect(claimed.world.turnEvents).toHaveLength(1);

    // 'a' now goes on break. They no longer hold any turn, so nothing moves.
    const away = setMyAvailability(claimed.world, {
      actorId: "a",
      status: "break",
    });
    expect(away.world.rotations.whatsapp.currentProfileId).toBe("b");
    expect(away.world.rotations.ringcentral.currentProfileId).toBe("b");
    expect(away.world.rotations.workload.currentProfileId).toBe("c");
    // Still exactly one event: the original claim. No second whatsapp advance.
    expect(away.world.turnEvents).toHaveLength(1);
    expect(
      away.world.turnEvents.filter((e) => e.rotation === "whatsapp"),
    ).toHaveLength(1);
  });

  it("an agent holding several rotations hands off each of them exactly once on break", () => {
    const before = makeWorld([agent("a", 1), agent("b", 2)], {
      whatsapp: "a",
      ringcentral: "a",
      workload: "a",
    });
    const away = setMyAvailability(before, { actorId: "a", status: "break" });

    for (const k of ROTATIONS) {
      expect(away.world.rotations[k].currentProfileId).toBe("b");
      expect(
        away.world.turnEvents.filter((e) => e.rotation === k),
      ).toHaveLength(1);
    }
    expect(away.world.turnEvents).toHaveLength(3);
  });

  it("a stale client acting after the queue advanced is rejected cleanly", () => {
    const before = makeWorld([agent("a", 1), agent("b", 2)], { whatsapp: "a" });
    const advanced = claimQuoteTurn(before, {
      actorId: "a",
      rotation: "whatsapp",
      customerName: "C",
      workType: "new_quote",
    }).world;

    // Stale tab still believes 'a' holds the turn.
    const stale = claimQuoteTurn(advanced, {
      actorId: "a",
      rotation: "whatsapp",
      customerName: "Stale",
      workType: "new_quote",
    });
    expect(stale.error?.message).toMatch(/belongs to another agent/i);
    expect(stale.world.workItems).toHaveLength(1);
  });
});

// ─── Customer Service Intake Queue ──────────────────────────────────────────

describe("Customer Service Intake Queue claim (one atomic workflow)", () => {
  function worldWithIntake(
    profiles: RotationProfile[],
    current: string | null,
    channel: "ringcentral" | "manual" = "ringcentral",
  ): World {
    const w = makeWorld(profiles, { ringcentral: current });
    w.intakes.push({
      id: "intake-1",
      status: "submitted",
      intakeChannel: channel,
      claimedBy: null,
      workItemId: null,
    });
    return w;
  }

  it("claims, converts, assigns, and advances the rotation exactly once", () => {
    const before = worldWithIntake([agent("a", 1), agent("b", 2)], "a");
    const { world: after, result, error } = claimIntakeThroughQueue(before, {
      actorId: "a",
      intakeId: "intake-1",
    });

    expect(error).toBeUndefined();
    const intake = after.intakes[0];
    expect(intake.status).toBe("converted");
    expect(intake.claimedBy).toBe("a");
    expect(intake.workItemId).toBe(result);

    expect(after.workItems).toHaveLength(1);
    expect(after.workItems[0]).toMatchObject({
      assignedProfileId: "a",
      assignmentMethod: "ringcentral_turn",
      receivedThrough: "Customer Service Intake Queue",
      sourceIntakeId: "intake-1",
    });

    expect(after.turnEvents).toHaveLength(1);
    expect(after.turnEvents[0]).toMatchObject({
      rotation: "ringcentral",
      action: "claim",
      previousProfileId: "a",
      nextProfileId: "b",
    });
    expect(after.rotations.ringcentral.currentProfileId).toBe("b");
    expectOnlyRotationChanged(before, after, "ringcentral");
  });

  it("browser retry returns the SAME work item and does not advance again", () => {
    const before = worldWithIntake([agent("a", 1), agent("b", 2)], "a");
    const first = claimIntakeThroughQueue(before, {
      actorId: "a",
      intakeId: "intake-1",
    });
    const retry = claimIntakeThroughQueue(first.world, {
      actorId: "a",
      intakeId: "intake-1",
    });

    expect(retry.error).toBeUndefined();
    expect(retry.result).toBe(first.result);
    expect(retry.world.workItems).toHaveLength(1);
    expect(retry.world.turnEvents).toHaveLength(1);
    expect(retry.world.rotations.ringcentral.currentProfileId).toBe("b");
    expect(retry.world.rotations.ringcentral.version).toBe(
      first.world.rotations.ringcentral.version,
    );
  });

  it("repeated retries stay idempotent", () => {
    let world = worldWithIntake([agent("a", 1), agent("b", 2)], "a");
    const ids = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const res = claimIntakeThroughQueue(world, {
        actorId: "a",
        intakeId: "intake-1",
      });
      if (res.result) ids.add(res.result);
      world = res.world;
    }
    expect(ids.size).toBe(1);
    expect(world.workItems).toHaveLength(1);
    expect(world.turnEvents).toHaveLength(1);
  });

  it("only the current queue agent can claim", () => {
    const before = worldWithIntake([agent("a", 1), agent("b", 2)], "a");
    const { world: after, error } = claimIntakeThroughQueue(before, {
      actorId: "b",
      intakeId: "intake-1",
    });
    expect(error?.message).toMatch(/belongs to another agent/i);
    expect(after.workItems).toHaveLength(0);
    expect(after.intakes[0].status).toBe("submitted");
    expectNoRotationChanged(before, after);
  });

  it("recovers an intake stranded as 'claimed' by the old workflow without duplicating", () => {
    const before = worldWithIntake([agent("a", 1), agent("b", 2)], "a");
    before.intakes[0].status = "claimed";
    before.intakes[0].claimedBy = "a";
    before.intakes[0].workItemId = null;

    const { world: after, error } = claimIntakeThroughQueue(before, {
      actorId: "a",
      intakeId: "intake-1",
    });
    expect(error).toBeUndefined();
    expect(after.workItems).toHaveLength(1);
    expect(after.intakes[0].status).toBe("converted");
    expect(after.turnEvents).toHaveLength(1);
  });

  it("a manager/manually assigned intake does NOT use the queue turn", () => {
    const before = worldWithIntake([agent("a", 1), agent("b", 2)], "a", "manual");
    const { world: after, error } = claimIntakeThroughQueue(before, {
      actorId: "a",
      intakeId: "intake-1",
    });
    expect(error?.message).toMatch(/manager\/manually assigned/i);
    expectNoRotationChanged(before, after);
  });

  it("manager assignment consumes no turn and moves no rotation", () => {
    const before = worldWithIntake([agent("a", 1), agent("b", 2)], "a");
    const { world: after, error } = managerAssignIntake(before, {
      actorId: "mgr",
      intakeId: "intake-1",
      targetAgentId: "b",
    });
    expect(error).toBeUndefined();
    expect(after.intakes[0].claimedBy).toBe("b");
    expect(after.intakes[0].intakeChannel).toBe("manual");
    expectNoRotationChanged(before, after);
  });

  it("with one eligible agent the queue self-loops rather than nulling", () => {
    const before = worldWithIntake([agent("solo", 3)], "solo");
    const { world: after, error } = claimIntakeThroughQueue(before, {
      actorId: "solo",
      intakeId: "intake-1",
    });
    expect(error).toBeUndefined();
    expect(after.rotations.ringcentral.currentProfileId).toBe("solo");
    expect(after.turnEvents[0].nextProfileId).toBe("solo");
  });

  // ─── Walk-in customers (v1.11.0) ─────────────────────────────────────────
  //
  // Only the designated walk-in agents may take a walk-in intake. The gate is a
  // pure rejection: it must never move a rotation, null a turn, create a work
  // item, or make the queue unusable for non-walk-in intakes.
  describe("walk-in intakes are restricted to the designated agents", () => {
    function worldWithWalkIn(current: string | null, profiles: RotationProfile[]): World {
      const w = worldWithIntake(profiles, current);
      w.intakes[0].isWalkIn = true;
      return w;
    }

    const walkInAgent = (
      id: string,
      position: number,
      overrides: Partial<RotationProfile> = {},
    ) => agent(id, position, { canClaimWalkIn: true, ...overrides });

    it("an unauthorized agent holding the turn is refused and the rotation does not move", () => {
      const before = worldWithWalkIn("a", [agent("a", 1), walkInAgent("b", 2)]);
      const { world: after, error } = claimIntakeThroughQueue(before, {
        actorId: "a",
        intakeId: "intake-1",
      });

      expect(error?.message).toMatch(/walk-in/i);
      expect(after.workItems).toHaveLength(0);
      expect(after.turnEvents).toHaveLength(0);
      expect(after.intakes[0].status).toBe("submitted");
      expect(after.intakes[0].claimedBy).toBeNull();
      expectNoRotationChanged(before, after);
    });

    it("an authorized agent holding the turn claims normally and advances once", () => {
      const before = worldWithWalkIn("b", [agent("a", 1), walkInAgent("b", 2)]);
      const { world: after, result, error } = claimIntakeThroughQueue(before, {
        actorId: "b",
        intakeId: "intake-1",
      });

      expect(error).toBeUndefined();
      expect(after.intakes[0].status).toBe("converted");
      expect(after.intakes[0].workItemId).toBe(result);
      expect(after.workItems).toHaveLength(1);
      expect(after.turnEvents).toHaveLength(1);
      expect(after.rotations.ringcentral.currentProfileId).toBe("a");
      expectOnlyRotationChanged(before, after, "ringcentral");
    });

    // ── v1.11.2: served out of turn, queue order untouched ──────────────────

    it("an authorized agent takes a walk-in out of turn WITHOUT changing the queue", () => {
      // The turn belongs to "a". "b" is authorized for walk-ins and takes it
      // anyway, because the customer is standing in the office.
      const before = worldWithWalkIn("a", [agent("a", 1), walkInAgent("b", 2)]);
      const { world: after, result, error } = claimIntakeThroughQueue(before, {
        actorId: "b",
        intakeId: "intake-1",
      });

      expect(error).toBeUndefined();
      expect(after.intakes[0].status).toBe("converted");
      expect(after.intakes[0].claimedBy).toBe("b");
      expect(after.workItems).toHaveLength(1);
      expect(after.workItems[0]).toMatchObject({
        assignedProfileId: "b",
        assignmentMethod: "ringcentral_turn",
        sourceIntakeId: "intake-1",
      });

      // The whole point: "a" still holds the turn, the version did not move, and
      // no turn event was written.
      expect(after.turnEvents).toHaveLength(0);
      expectNoRotationChanged(before, after);
      expect(result).toBe(after.workItems[0].id);
    });

    it("taking a walk-in out of turn does not skip or reorder anyone", () => {
      const before = worldWithWalkIn("a", [
        agent("a", 1),
        walkInAgent("b", 2),
        agent("c", 3),
      ]);
      const walkIn = claimIntakeThroughQueue(before, {
        actorId: "b",
        intakeId: "intake-1",
      });
      expect(walkIn.error).toBeUndefined();

      // "a" now takes a normal intake. The turn must pass to "b" — exactly where
      // it would have gone had the walk-in never happened.
      walkIn.world.intakes.push({
        id: "intake-2",
        status: "submitted",
        intakeChannel: "ringcentral",
        claimedBy: null,
        workItemId: null,
      });
      const normal = claimIntakeThroughQueue(walkIn.world, {
        actorId: "a",
        intakeId: "intake-2",
      });

      expect(normal.error).toBeUndefined();
      expect(normal.world.rotations.ringcentral.currentProfileId).toBe("b");
      expect(normal.world.turnEvents).toHaveLength(1);
      expect(normal.world.turnEvents[0]).toMatchObject({
        previousProfileId: "a",
        nextProfileId: "b",
      });
    });

    it("an out-of-turn walk-in claim is idempotent on retry", () => {
      const before = worldWithWalkIn("a", [agent("a", 1), walkInAgent("b", 2)]);
      const first = claimIntakeThroughQueue(before, {
        actorId: "b",
        intakeId: "intake-1",
      });
      const retry = claimIntakeThroughQueue(first.world, {
        actorId: "b",
        intakeId: "intake-1",
      });

      expect(retry.error).toBeUndefined();
      expect(retry.result).toBe(first.result);
      expect(retry.world.workItems).toHaveLength(1);
      expect(retry.world.turnEvents).toHaveLength(0);
      expectNoRotationChanged(before, retry.world);
    });

    it("rotation membership is not required to take a walk-in out of turn", () => {
      // RingCentral switched off, so this agent can never be the turn holder.
      // They must still be able to serve a walk-in, and still change nothing.
      const before = worldWithWalkIn("a", [
        agent("a", 1),
        walkInAgent("b", 2, { ringcentralActive: false }),
      ]);
      const { world: after, error } = claimIntakeThroughQueue(before, {
        actorId: "b",
        intakeId: "intake-1",
      });

      expect(error).toBeUndefined();
      expect(after.workItems).toHaveLength(1);
      expect(after.turnEvents).toHaveLength(0);
      expectNoRotationChanged(before, after);
    });

    it("an unavailable walk-in agent is still refused", () => {
      const before = worldWithWalkIn("a", [
        agent("a", 1),
        walkInAgent("b", 2, { availability: "unavailable" }),
      ]);
      const { world: after, error } = claimIntakeThroughQueue(before, {
        actorId: "b",
        intakeId: "intake-1",
      });

      expect(error?.message).toMatch(/available/i);
      expect(after.workItems).toHaveLength(0);
      expect(after.intakes[0].status).toBe("submitted");
      expectNoRotationChanged(before, after);
    });

    it("a walk-in claimed while holding the turn consumes it exactly once, even with three agents", () => {
      const before = worldWithWalkIn("b", [
        agent("a", 1),
        walkInAgent("b", 2),
        agent("c", 3),
      ]);
      const { world: after, error } = claimIntakeThroughQueue(before, {
        actorId: "b",
        intakeId: "intake-1",
      });

      expect(error).toBeUndefined();
      expect(after.turnEvents).toHaveLength(1);
      expect(after.rotations.ringcentral.currentProfileId).toBe("c");
      expectOnlyRotationChanged(before, after, "ringcentral");
    });

    it("a refused walk-in leaves the queue usable for the next normal intake", () => {
      const before = worldWithWalkIn("a", [agent("a", 1), walkInAgent("b", 2)]);
      before.intakes.push({
        id: "intake-2",
        status: "submitted",
        intakeChannel: "ringcentral",
        claimedBy: null,
        workItemId: null,
      });

      const refused = claimIntakeThroughQueue(before, {
        actorId: "a",
        intakeId: "intake-1",
      });
      expect(refused.error).toBeDefined();

      const allowed = claimIntakeThroughQueue(refused.world, {
        actorId: "a",
        intakeId: "intake-2",
      });
      expect(allowed.error).toBeUndefined();
      expect(allowed.world.turnEvents).toHaveLength(1);
      expect(allowed.world.rotations.ringcentral.currentProfileId).toBe("b");
    });

    it("a double-clicked refusal is still a no-op", () => {
      let world = worldWithWalkIn("a", [agent("a", 1), walkInAgent("b", 2)]);
      const original = world;
      for (let i = 0; i < 4; i++) {
        const res = claimIntakeThroughQueue(world, {
          actorId: "a",
          intakeId: "intake-1",
        });
        expect(res.error).toBeDefined();
        world = res.world;
      }
      expect(world.workItems).toHaveLength(0);
      expect(world.turnEvents).toHaveLength(0);
      expectNoRotationChanged(original, world);
    });

    it("a retry after a successful walk-in claim returns the same work item", () => {
      const before = worldWithWalkIn("b", [agent("a", 1), walkInAgent("b", 2)]);
      const first = claimIntakeThroughQueue(before, {
        actorId: "b",
        intakeId: "intake-1",
      });
      const retry = claimIntakeThroughQueue(first.world, {
        actorId: "b",
        intakeId: "intake-1",
      });

      expect(retry.error).toBeUndefined();
      expect(retry.result).toBe(first.result);
      expect(retry.world.workItems).toHaveLength(1);
      expect(retry.world.turnEvents).toHaveLength(1);
      expect(retry.world.rotations.ringcentral.version).toBe(
        first.world.rotations.ringcentral.version,
      );
    });

    it("manager assignment of a walk-in must target an authorized agent", () => {
      const before = worldWithWalkIn("a", [agent("a", 1), walkInAgent("b", 2)]);

      const refused = managerAssignIntake(before, {
        actorId: "mgr",
        intakeId: "intake-1",
        targetAgentId: "a",
      });
      expect(refused.error?.message).toMatch(/walk-in/i);
      expect(refused.world.intakes[0].status).toBe("submitted");
      expectNoRotationChanged(before, refused.world);

      const allowed = managerAssignIntake(before, {
        actorId: "mgr",
        intakeId: "intake-1",
        targetAgentId: "b",
      });
      expect(allowed.error).toBeUndefined();
      expect(allowed.world.intakes[0].claimedBy).toBe("b");
      expect(allowed.world.intakes[0].intakeChannel).toBe("manual");
      // Assignment is never a turn-consuming action, walk-in or not.
      expectNoRotationChanged(before, allowed.world);
    });

    it("non-walk-in intakes are unaffected by the gate", () => {
      const before = worldWithIntake([agent("a", 1), agent("b", 2)], "a");
      const { world: after, error } = claimIntakeThroughQueue(before, {
        actorId: "a",
        intakeId: "intake-1",
      });
      expect(error).toBeUndefined();
      expect(after.turnEvents).toHaveLength(1);
      expectOnlyRotationChanged(before, after, "ringcentral");
    });
  });
});

// ─── Manual quote / requote stays a parallel workflow ───────────────────────

describe("manual quote and requote remain fully available", () => {
  it("works without any intake, without holding the turn, and moves no rotation", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<"new_quote" | "requote">("new_quote", "requote"),
        fc.constantFrom(
          "Direct customer call",
          "Walk-in",
          "Referral",
          "Existing customer requote",
          "Email",
        ),
        (workType, source) => {
          // 'b' does NOT hold any turn.
          const before = makeWorld([agent("a", 1), agent("b", 2)], {
            whatsapp: "a",
            ringcentral: "a",
            workload: "a",
          });
          const { world: after, result, error } = logManualQuote(before, {
            actorId: "b",
            customerName: "Jane Doe",
            workType,
            receivedThrough: source,
          });

          expect(error).toBeUndefined();
          expect(result).toMatchObject({
            assignedProfileId: "b",
            assignmentMethod: "manual_quote",
            receivedThrough: source,
            workType,
          });
          expect(after.intakes).toHaveLength(0);
          expectNoRotationChanged(before, after);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("is not blocked when the agent is not the current turn holder", () => {
    const before = makeWorld([agent("a", 1), agent("b", 2)], { whatsapp: "a" });
    const { error } = logManualQuote(before, {
      actorId: "b",
      customerName: "C",
      workType: "requote",
      receivedThrough: "Direct customer call",
    });
    expect(error).toBeUndefined();
  });

  it("is not blocked when every rotation is empty", () => {
    const before = makeWorld([agent("a", 1, { availability: "break" })], {
      whatsapp: null,
      ringcentral: null,
      workload: null,
    });
    const { world: after, error } = logManualQuote(before, {
      actorId: "a",
      customerName: "C",
      workType: "new_quote",
      receivedThrough: "Direct customer call",
    });
    expect(error).toBeUndefined();
    expect(after.workItems).toHaveLength(1);
    expectNoRotationChanged(before, after);
  });

  it("stays distinguishable from a queue-claimed quote", () => {
    let world = makeWorld([agent("a", 1), agent("b", 2)], { whatsapp: "a" });
    world = claimQuoteTurn(world, {
      actorId: "a",
      rotation: "whatsapp",
      customerName: "Queue",
      workType: "new_quote",
    }).world;
    world = logManualQuote(world, {
      actorId: "a",
      customerName: "Manual",
      workType: "requote",
      receivedThrough: "Direct customer call",
    }).world;

    const methods = world.workItems.map((i) => i.assignmentMethod);
    expect(methods).toEqual(["whatsapp_turn", "manual_quote"]);
    // Only the queue claim produced a turn event.
    expect(world.turnEvents).toHaveLength(1);
  });

  it("requires the agent to record the actual source", () => {
    const before = makeWorld([agent("a", 1)]);
    const { error } = logManualQuote(before, {
      actorId: "a",
      customerName: "C",
      workType: "new_quote",
      receivedThrough: "  ",
    });
    expect(error?.message).toMatch(/where this quote came from/i);
  });

  it("manual workload moves no rotation either", () => {
    const before = makeWorld([agent("a", 1), agent("b", 2)]);
    const { world: after, error } = logManualWorkload(before, {
      actorId: "a",
      customerName: "C",
    });
    expect(error).toBeUndefined();
    expect(after.workItems[0].assignmentMethod).toBe("manual_workload");
    expectNoRotationChanged(before, after);
  });
});

// ─── Rotation independence ──────────────────────────────────────────────────

describe("invariant 1: rotations are fully independent", () => {
  it("any single claim touches exactly one rotation", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ROTATIONS),
        fc.integer({ min: 1, max: 4 }),
        (rotation, n) => {
          const profiles = Array.from({ length: n }, (_, i) =>
            agent(`a${i + 1}`, i + 1),
          );
          const before = makeWorld(profiles);
          const holder = before.rotations[rotation].currentProfileId!;
          const { world: after, error } = claimQuoteTurn(before, {
            actorId: holder,
            rotation,
            customerName: "C",
            workType: "new_quote",
          });
          expect(error).toBeUndefined();
          expectOnlyRotationChanged(before, after, rotation);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("a long random action sequence never violates the core invariants", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom("claim", "pass", "avail", "eligibility"),
            rotation: fc.constantFrom(...ROTATIONS),
            actorIdx: fc.integer({ min: 0, max: 2 }),
            status: fc.constantFrom("available", "break", "unavailable"),
            active: fc.boolean(),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        (ops) => {
          const profiles = [agent("a1", 1), agent("a2", 2), agent("a3", 3)];
          let world = makeWorld(profiles);

          for (const op of ops) {
            const actor = `a${op.actorIdx + 1}`;
            if (op.kind === "claim") {
              const holder = world.rotations[op.rotation].currentProfileId;
              if (holder) {
                world = claimQuoteTurn(world, {
                  actorId: holder,
                  rotation: op.rotation,
                  customerName: "C",
                  workType: "new_quote",
                }).world;
              }
            } else if (op.kind === "pass" && op.rotation !== "workload") {
              const holder = world.rotations[op.rotation].currentProfileId;
              if (holder) {
                world = passMyTurn(world, {
                  actorId: holder,
                  rotation: op.rotation,
                  reason: "r",
                }).world;
              }
            } else if (op.kind === "avail") {
              world = setMyAvailability(world, {
                actorId: actor,
                status: op.status,
              }).world;
            } else if (op.kind === "eligibility") {
              world = managerSetRotationEligibility(world, {
                actorId: "mgr",
                targetId: actor,
                rotation: op.rotation,
                active: op.active,
                reason: "r",
              }).world;
            }

            // ── Invariants checked after EVERY operation ──
            for (const k of ROTATIONS) {
              const cur = world.rotations[k].currentProfileId;
              const elig = eligibleAgents(world.profiles, k);

              // Invariant 3: never null while an eligible agent exists.
              if (elig.length > 0) {
                expect(cur).not.toBeNull();
              }
              // Invariant 4: the current agent is always fully eligible.
              if (cur !== null) {
                const p = world.profiles.find((x) => x.id === cur)!;
                expect(isEligible(p, k)).toBe(true);
              }
              // Invariant 6: null is only allowed when the eligible set is empty.
              if (cur === null) {
                expect(elig).toHaveLength(0);
              }
            }
            // Every event names a rotation and an action.
            for (const e of world.turnEvents) {
              expect(ROTATIONS).toContain(e.rotation);
              expect(e.action).toBeTruthy();
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ─── cloneWorld sanity (the harness itself must not leak state) ─────────────

describe("harness integrity", () => {
  it("cloneWorld produces a deep copy", () => {
    const w = makeWorld([agent("a", 1)]);
    const c = cloneWorld(w);
    c.rotations.whatsapp.currentProfileId = "changed";
    c.profiles[0].availability = "break";
    expect(w.rotations.whatsapp.currentProfileId).toBe("a");
    expect(w.profiles[0].availability).toBe("available");
  });
});

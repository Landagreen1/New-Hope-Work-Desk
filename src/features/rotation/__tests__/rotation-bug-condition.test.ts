/**
 * BUG CONDITION tests for queue-rotation-integrity.
 *
 * These prove root cause RC-1 is real by running the reproduced LIVE selector
 * (`nextEligibleProfileLiveBroken`) against the mandatory invariants and
 * asserting that it FAILS them, while the corrected selector passes.
 *
 * They are written to PASS on this branch: each test asserts the presence of the
 * defect. They are the executable form of the evidence in
 * `.kiro/specs/queue-rotation-integrity/bugfix.md` §2.
 *
 * Live reference incident (2026-07-31, from public.turn_events):
 *   00:30:30  Miguel Leiva, whatsapp_position 8, went unavailable
 *             -> next_eligible_profile('whatsapp', 8) returned NULL
 *             -> rotation nulled, reason "no eligible agent is currently available"
 *   00:31:13  Mauricio Plaza, workload_position 3, went unavailable
 *             -> next_eligible_profile('workload', 3) returned Estefania Bayas (pos 5)
 *   Estefania was enabled on all three rotations at position 5 the whole time.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  eligibleAgents,
  isEligible,
  nextEligibleProfile,
  nextEligibleProfileLiveBroken,
  type RotationKind,
  type RotationProfile,
} from "../rotation-engine";

// ─── helpers ────────────────────────────────────────────────────────────────

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

const ROTATIONS: RotationKind[] = ["whatsapp", "ringcentral", "workload"];

/** Arbitrary roster of eligible agents with distinct positions. */
const rosterArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 40 }), {
    minLength: 1,
    maxLength: 8,
  })
  .map((positions) =>
    positions
      .slice()
      .sort((a, b) => a - b)
      .map((p) => agent(`agent-${String(p).padStart(2, "0")}`, p)),
  );

// ─── 1. The exact production incident ───────────────────────────────────────

describe("RC-1: reproduction of the 2026-07-31 production incident", () => {
  // Roster as it existed live: positions 2..11, only position 5 available.
  const liveRoster: RotationProfile[] = [
    agent("berenice", 2, { availability: "unavailable" }),
    agent("mauricio", 3, { availability: "unavailable" }),
    agent("galo", 4, { availability: "unavailable" }),
    agent("estefania", 5, { availability: "available" }),
    agent("pablo", 6, { availability: "unavailable" }),
    agent("elvin", 7, { availability: "unavailable" }),
    agent("miguel", 8, { availability: "unavailable" }),
    agent("zumarraga", 9, { availability: "unavailable" }),
    agent("trujillo", 10, { availability: "unavailable" }),
    agent("juliana", 11, { availability: "unavailable" }),
  ];

  it("live selector returns NULL for whatsapp from position 8 despite an eligible agent at position 5", () => {
    expect(eligibleAgents(liveRoster, "whatsapp").map((a) => a.id)).toEqual([
      "estefania",
    ]);

    // This is the defect: an eligible agent exists, yet the selector says nobody.
    expect(nextEligibleProfileLiveBroken(liveRoster, "whatsapp", 8)).toBeNull();

    // The corrected selector wraps around and finds her.
    expect(nextEligibleProfile(liveRoster, "whatsapp", 8)).toBe("estefania");
  });

  it("explains why workload succeeded 43s later while whatsapp/ringcentral nulled", () => {
    // Mauricio sat at position 3, BELOW Estefania at 5, so the broken
    // `pos > after` filter still matched her. Nothing about workload was
    // healthier — it was pure position luck.
    expect(nextEligibleProfileLiveBroken(liveRoster, "workload", 3)).toBe(
      "estefania",
    );
    expect(nextEligibleProfileLiveBroken(liveRoster, "whatsapp", 8)).toBeNull();
    expect(
      nextEligibleProfileLiveBroken(liveRoster, "ringcentral", 8),
    ).toBeNull();
  });

  it("live selector returns NULL from EVERY position 1..20 once only position 5 is eligible and after>=5", () => {
    for (let after = 5; after <= 20; after++) {
      expect(
        nextEligibleProfileLiveBroken(liveRoster, "whatsapp", after),
      ).toBeNull();
      // Corrected selector always finds the sole eligible agent.
      expect(nextEligibleProfile(liveRoster, "whatsapp", after)).toBe(
        "estefania",
      );
    }
  });
});

// ─── 2. Invariant 10 — single eligible agent ────────────────────────────────

describe("RC-1: invariant 10 (single eligible agent must keep the turn)", () => {
  it("live selector can never return the only eligible agent (p > p is false)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.constantFrom(...ROTATIONS),
        (position, rotation) => {
          const roster = [agent("solo", position)];
          expect(isEligible(roster[0], rotation)).toBe(true);

          // DEFECT: the sole eligible agent is unreachable from their own position.
          expect(
            nextEligibleProfileLiveBroken(roster, rotation, position),
          ).toBeNull();

          // FIXED: self-loop.
          expect(nextEligibleProfile(roster, rotation, position)).toBe("solo");
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── 3. Invariant 9 — wraparound ────────────────────────────────────────────

describe("RC-1: invariant 9 (order must wrap from highest position to lowest)", () => {
  it("live selector returns NULL when the current agent holds the highest eligible position", () => {
    fc.assert(
      fc.property(rosterArb, fc.constantFrom(...ROTATIONS), (roster, rotation) => {
        const positions = roster.map(
          (a) => a[`${rotationKey(rotation)}Position`] as number,
        );
        const highest = Math.max(...positions);

        // DEFECT: nothing sorts above the highest position, so the queue dies here.
        expect(
          nextEligibleProfileLiveBroken(roster, rotation, highest),
        ).toBeNull();

        // FIXED: wraps to the lowest-positioned eligible agent.
        const lowest = Math.min(...positions);
        const expected = roster.find(
          (a) => (a[`${rotationKey(rotation)}Position`] as number) === lowest,
        )!.id;
        expect(nextEligibleProfile(roster, rotation, highest)).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });
});

// ─── 4. Invariant 3 — never null while eligible agents exist ────────────────

describe("RC-1: invariant 3 (never null while an eligible agent exists)", () => {
  it("corrected selector NEVER returns null when at least one agent is eligible", () => {
    fc.assert(
      fc.property(
        rosterArb,
        fc.constantFrom(...ROTATIONS),
        fc.option(fc.integer({ min: -5, max: 60 }), { nil: null }),
        (roster, rotation, after) => {
          expect(eligibleAgents(roster, rotation).length).toBeGreaterThan(0);
          expect(nextEligibleProfile(roster, rotation, after)).not.toBeNull();
        },
      ),
      { numRuns: 400 },
    );
  });

  it("live selector DOES return null in cases where eligible agents exist", () => {
    // Existence proof across the arbitrary space, not a single hand-picked case.
    let violations = 0;
    fc.assert(
      fc.property(rosterArb, fc.constantFrom(...ROTATIONS), (roster, rotation) => {
        const positions = roster.map(
          (a) => a[`${rotationKey(rotation)}Position`] as number,
        );
        if (nextEligibleProfileLiveBroken(roster, rotation, Math.max(...positions)) === null) {
          violations++;
        }
        return true;
      }),
      { numRuns: 200 },
    );
    expect(violations).toBeGreaterThan(0);
  });
});

// ─── 5. RC-5 — null positions and duplicate positions ──────────────────────

describe("RC-5: eligibility hygiene", () => {
  it("an agent with a NULL position is never eligible and never selected", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ROTATIONS), (rotation) => {
        const roster = [agent("nullpos", null), agent("valid", 3)];
        expect(isEligible(roster[0], rotation)).toBe(false);

        for (let after = 0; after <= 10; after++) {
          expect(nextEligibleProfile(roster, rotation, after)).toBe("valid");
        }
        // And with ONLY a null-position agent, the queue is legitimately empty.
        expect(nextEligibleProfile([roster[0]], rotation, 1)).toBeNull();
      }),
      { numRuns: 60 },
    );
  });

  it("duplicate positions resolve deterministically and identically across calls", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.constantFrom(...ROTATIONS),
        (position, rotation) => {
          // Same position, inserted in two different orders.
          const a = agent("zzz-agent", position);
          const b = agent("aaa-agent", position);
          const first = nextEligibleProfile([a, b], rotation, 0);
          const second = nextEligibleProfile([b, a], rotation, 0);

          expect(first).toBe(second);
          // Tiebreak is by id, so the lexicographically smaller id wins.
          expect(first).toBe("aaa-agent");
        },
      ),
      { numRuns: 120 },
    );
  });

  it("position gaps do not break advancement", () => {
    const roster = [agent("a", 1), agent("b", 7), agent("c", 99)];
    expect(nextEligibleProfile(roster, "whatsapp", 1)).toBe("b");
    expect(nextEligibleProfile(roster, "whatsapp", 7)).toBe("c");
    expect(nextEligibleProfile(roster, "whatsapp", 99)).toBe("a"); // wrap
  });
});

// ─── 6. Role scope — agent-only ────────────────────────────────────────────

describe("Role scope: rotations are agent-only", () => {
  it("sales_supervisor and manager are never eligible and never selected", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("sales_supervisor", "manager", "super_admin", "customer_service", "commercial"),
        fc.constantFrom(...ROTATIONS),
        (role, rotation) => {
          const nonAgent = agent("supervisor", 1, { role });
          expect(isEligible(nonAgent, rotation)).toBe(false);
          expect(nextEligibleProfile([nonAgent], rotation, 0)).toBeNull();

          // Presence of a non-agent must not influence the next-agent result.
          const withAgent = [nonAgent, agent("realagent", 5)];
          expect(nextEligibleProfile(withAgent, rotation, 0)).toBe("realagent");
        },
      ),
      { numRuns: 150 },
    );
  });
});

function rotationKey(rotation: RotationKind): "whatsapp" | "ringcentral" | "workload" {
  return rotation;
}

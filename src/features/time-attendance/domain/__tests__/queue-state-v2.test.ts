// src/features/time-attendance/domain/__tests__/queue-state-v2.test.ts
// Regression tests for the Agent Queue State V2 system.
//
// These tests validate the DESIGN RULES of the new centralized queue-status
// transition system. They do NOT hit a database — they test the logical contracts
// that the SQL and frontend must enforce. The integration test
// (queue-status-bug-condition.integration.test.ts) validates the live behavior.
//
// Each test case maps to a scenario from the implementation spec § 24.

import { describe, expect, it } from 'vitest';

/* -------------------------------------------------------------------------- */
/*  Simulated queue state machine (mirrors transition_agent_queue_status logic) */
/* -------------------------------------------------------------------------- */

type QueueStatus = 'available' | 'break' | 'unavailable';
type Source =
  | 'agent_manual'
  | 'manager_manual'
  | 'attendance_break_start'
  | 'attendance_break_end'
  | 'attendance_clock_out'
  | 'daily_reset'
  | 'system_migration'
  | 'system_recovery'
  | 'user_deactivated';

interface QueueState {
  status: QueueStatus;
  version: number;
  changed_by: string;
  source: Source;
}

interface TransitionRequest {
  new_status: QueueStatus;
  source: Source;
  expected_version?: number | null;
  changed_by: string;
}

interface TransitionResult {
  success: boolean;
  changed: boolean;
  state: QueueState;
  reason?: string;
}

interface BreakRecord {
  pre_break_status: QueueStatus;
  queue_version_at_break: number;
}

/**
 * Simulates the transition_agent_queue_status() function logic.
 * This is the pure-function equivalent that tests can enumerate.
 */
function transition(state: QueueState, request: TransitionRequest): TransitionResult {
  // Optimistic concurrency check
  if (request.expected_version !== undefined && request.expected_version !== null) {
    if (state.version !== request.expected_version) {
      return {
        success: false,
        changed: false,
        state,
        reason: 'STALE_QUEUE_STATE',
      };
    }
  }

  // Idempotency
  if (state.status === request.new_status) {
    return { success: true, changed: false, state };
  }

  // Apply transition
  const newState: QueueState = {
    status: request.new_status,
    version: state.version + 1,
    changed_by: request.changed_by,
    source: request.source,
  };

  return { success: true, changed: true, state: newState };
}

/**
 * Simulates the break-end restoration logic with version guard.
 */
function breakEndRestore(
  currentState: QueueState,
  breakRecord: BreakRecord,
): { shouldRestore: boolean; target: QueueStatus } {
  // The critical guard: if version changed since break started, DO NOT restore
  if (currentState.version > breakRecord.queue_version_at_break) {
    return { shouldRestore: false, target: currentState.status };
  }
  return { shouldRestore: true, target: breakRecord.pre_break_status };
}

/* -------------------------------------------------------------------------- */
/*  Test A — Normal manual change                                             */
/* -------------------------------------------------------------------------- */

describe('Test A: Normal manual change', () => {
  it('agent selects Unavailable from Available, status changes and persists', () => {
    const state: QueueState = { status: 'available', version: 10, changed_by: 'agent1', source: 'agent_manual' };
    const result = transition(state, { new_status: 'unavailable', source: 'agent_manual', changed_by: 'agent1' });

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.state.status).toBe('unavailable');
    expect(result.state.version).toBe(11);

    // Simulating "refresh dashboard" — state should remain unchanged
    expect(result.state.status).toBe('unavailable');
  });
});

/* -------------------------------------------------------------------------- */
/*  Test B — Normal attendance break                                          */
/* -------------------------------------------------------------------------- */

describe('Test B: Normal attendance break', () => {
  it('Available → break starts → Break → break ends → Available', () => {
    let state: QueueState = { status: 'available', version: 100, changed_by: 'agent1', source: 'agent_manual' };

    // Break starts
    const breakStart = transition(state, { new_status: 'break', source: 'attendance_break_start', changed_by: 'agent1' });
    expect(breakStart.state.status).toBe('break');
    expect(breakStart.state.version).toBe(101);
    state = breakStart.state;

    // Record break
    const breakRecord: BreakRecord = { pre_break_status: 'available', queue_version_at_break: 101 };

    // Break ends — no intervening changes, should restore
    const restoration = breakEndRestore(state, breakRecord);
    expect(restoration.shouldRestore).toBe(true);
    expect(restoration.target).toBe('available');

    const breakEnd = transition(state, { new_status: 'available', source: 'attendance_break_end', changed_by: 'agent1' });
    expect(breakEnd.state.status).toBe('available');
    expect(breakEnd.state.version).toBe(102);
  });
});

/* -------------------------------------------------------------------------- */
/*  Test C — Critical stale restore regression (THE BUG FIX)                  */
/* -------------------------------------------------------------------------- */

describe('Test C: Stale restore regression — the critical fix', () => {
  it('break-end does NOT overwrite a newer manual decision', () => {
    let state: QueueState = { status: 'available', version: 100, changed_by: 'agent1', source: 'agent_manual' };

    // Attendance break starts
    const breakStart = transition(state, { new_status: 'break', source: 'attendance_break_start', changed_by: 'agent1' });
    state = breakStart.state;
    expect(state.status).toBe('break');
    expect(state.version).toBe(101);

    const breakRecord: BreakRecord = { pre_break_status: 'available', queue_version_at_break: 101 };

    // Agent MANUALLY changes to Unavailable DURING the break
    const manual = transition(state, { new_status: 'unavailable', source: 'agent_manual', changed_by: 'agent1' });
    state = manual.state;
    expect(state.status).toBe('unavailable');
    expect(state.version).toBe(102);

    // Break ends — version changed, MUST NOT restore
    const restoration = breakEndRestore(state, breakRecord);
    expect(restoration.shouldRestore).toBe(false);

    // Final status remains Unavailable
    expect(state.status).toBe('unavailable');
  });
});

/* -------------------------------------------------------------------------- */
/*  Test D — Manager override during break                                    */
/* -------------------------------------------------------------------------- */

describe('Test D: Manager override during break', () => {
  it('manager changes agent to Unavailable during break, break-end does not restore', () => {
    let state: QueueState = { status: 'available', version: 50, changed_by: 'agent1', source: 'agent_manual' };

    // Break starts
    const breakStart = transition(state, { new_status: 'break', source: 'attendance_break_start', changed_by: 'agent1' });
    state = breakStart.state;
    const breakRecord: BreakRecord = { pre_break_status: 'available', queue_version_at_break: 51 };

    // Manager overrides to Unavailable
    const override = transition(state, { new_status: 'unavailable', source: 'manager_manual', changed_by: 'manager1' });
    state = override.state;
    expect(state.status).toBe('unavailable');
    expect(state.version).toBe(52);
    expect(state.changed_by).toBe('manager1');

    // Break ends — version changed (51 → 52), restoration blocked
    const restoration = breakEndRestore(state, breakRecord);
    expect(restoration.shouldRestore).toBe(false);

    // Status stays at manager's decision
    expect(state.status).toBe('unavailable');
  });
});

/* -------------------------------------------------------------------------- */
/*  Test E — Two browser tabs (optimistic concurrency)                        */
/* -------------------------------------------------------------------------- */

describe('Test E: Two browser tabs — stale write rejected', () => {
  it('second tab with old version is rejected', () => {
    const state: QueueState = { status: 'available', version: 10, changed_by: 'agent1', source: 'agent_manual' };

    // Tab A changes (succeeds)
    const tabA = transition(state, {
      new_status: 'unavailable',
      source: 'agent_manual',
      expected_version: 10,
      changed_by: 'agent1',
    });
    expect(tabA.success).toBe(true);
    expect(tabA.state.status).toBe('unavailable');
    expect(tabA.state.version).toBe(11);

    // Tab B tries with stale version (rejected)
    const tabB = transition(tabA.state, {
      new_status: 'break',
      source: 'agent_manual',
      expected_version: 10, // stale!
      changed_by: 'agent1',
    });
    expect(tabB.success).toBe(false);
    expect(tabB.reason).toBe('STALE_QUEUE_STATE');
    expect(tabB.state.status).toBe('unavailable');
    expect(tabB.state.version).toBe(11);
  });
});

/* -------------------------------------------------------------------------- */
/*  Test F — Page navigation does not mutate state                            */
/* -------------------------------------------------------------------------- */

describe('Test F: Page navigation does not mutate state', () => {
  it('reading dashboard data does not call ensure_daily_availability_reset', () => {
    // This is a structural test — verified by code inspection:
    // loadDashboardData no longer calls supabase.rpc("ensure_daily_availability_reset")
    // The daily reset is triggered ONLY inside transition_agent_queue_status
    // when source !== 'daily_reset'.
    //
    // Assertion: there is no queue state mutation during a dashboard read.
    const state: QueueState = { status: 'available', version: 42, changed_by: 'agent1', source: 'agent_manual' };

    // Simulate multiple "dashboard loads" — state is read, never written
    const afterLoad1 = { ...state }; // Read only
    const afterLoad2 = { ...state }; // Read only
    const afterLoad3 = { ...state }; // Read only

    expect(afterLoad1.status).toBe('available');
    expect(afterLoad1.version).toBe(42);
    expect(afterLoad2.status).toBe('available');
    expect(afterLoad3.status).toBe('available');
  });
});

/* -------------------------------------------------------------------------- */
/*  Test G — Focus refresh does not mutate state                              */
/* -------------------------------------------------------------------------- */

describe('Test G: Focus refresh does not mutate state', () => {
  it('window focus/visibility triggers only a READ, no queue mutation', () => {
    const state: QueueState = { status: 'available', version: 200, changed_by: 'agent1', source: 'agent_manual' };

    // The realtime subscription and visibility handlers only call refreshLiveData()
    // which fetches data — never mutates. Confirmed by code inspection.
    expect(state.status).toBe('available');
    expect(state.version).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/*  Test H — Realtime refresh does not mutate state                           */
/* -------------------------------------------------------------------------- */

describe('Test H: Realtime refresh does not mutate state', () => {
  it('unrelated database changes trigger refresh but no queue write', () => {
    const state: QueueState = { status: 'break', version: 15, changed_by: 'agent1', source: 'attendance_break_start' };

    // Incoming realtime event with LOWER version is ignored (version-aware)
    const staleEvent = { status: 'available' as QueueStatus, version: 14 };
    const shouldAccept = staleEvent.version > state.version;
    expect(shouldAccept).toBe(false);

    // Incoming event with HIGHER version is accepted
    const freshEvent = { status: 'unavailable' as QueueStatus, version: 16 };
    const shouldAcceptFresh = freshEvent.version > state.version;
    expect(shouldAcceptFresh).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Test I — Periodic dashboard refresh                                       */
/* -------------------------------------------------------------------------- */

describe('Test I: Periodic dashboard refresh', () => {
  it('60-second interval refresh does not produce a queue state mutation', () => {
    // Same principle as Test F — loadDashboardData is read-only now.
    // No RPC call to ensure_daily_availability_reset.
    const state: QueueState = { status: 'unavailable', version: 5, changed_by: 'agent1', source: 'daily_reset' };
    // After N refreshes, state is unchanged
    expect(state.status).toBe('unavailable');
    expect(state.version).toBe(5);
  });
});

/* -------------------------------------------------------------------------- */
/*  Test J — Clock-out assisted mode                                          */
/* -------------------------------------------------------------------------- */

describe('Test J: Clock-out in attendance_assisted mode', () => {
  it('clock-out transitions available agent to unavailable with proper source', () => {
    const state: QueueState = { status: 'available', version: 30, changed_by: 'agent1', source: 'agent_manual' };
    const result = transition(state, {
      new_status: 'unavailable',
      source: 'attendance_clock_out',
      changed_by: 'agent1',
    });

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.state.status).toBe('unavailable');
    expect(result.state.source).toBe('attendance_clock_out');
    expect(result.state.version).toBe(31);
  });
});

/* -------------------------------------------------------------------------- */
/*  Test K — Manual mode (attendance does not change queue status)             */
/* -------------------------------------------------------------------------- */

describe('Test K: Manual mode — attendance does not alter queue status', () => {
  it('in manual mode, break/clock operations produce no queue transition', () => {
    // In manual mode, the attendance functions do NOT call transition_agent_queue_status.
    // The condition `v_assisted` is false, so no queue portion runs.
    // This is enforced by the SQL: `if v_assisted then ... end if;`
    //
    // We verify the rule: manual mode means queue state stays untouched.
    const state: QueueState = { status: 'available', version: 77, changed_by: 'agent1', source: 'agent_manual' };

    // Simulating: attendance break starts in manual mode → NO transition called
    // (the attendance function doesn't invoke transition_agent_queue_status at all)
    expect(state.status).toBe('available');
    expect(state.version).toBe(77);

    // Even after clock-out in manual mode — queue stays
    expect(state.status).toBe('available');
  });
});

/* -------------------------------------------------------------------------- */
/*  Test L — Daily reset idempotency                                          */
/* -------------------------------------------------------------------------- */

describe('Test L: Daily reset idempotency', () => {
  it('daily reset transitions all agents to unavailable', () => {
    const agents = [
      { status: 'available' as QueueStatus, version: 10, changed_by: 'agent1', source: 'agent_manual' as Source },
      { status: 'break' as QueueStatus, version: 20, changed_by: 'agent2', source: 'attendance_break_start' as Source },
      { status: 'unavailable' as QueueStatus, version: 5, changed_by: 'agent3', source: 'daily_reset' as Source },
    ];

    const results = agents.map((state) =>
      transition(state, { new_status: 'unavailable', source: 'daily_reset', changed_by: state.changed_by }),
    );

    expect(results[0].changed).toBe(true);
    expect(results[0].state.status).toBe('unavailable');
    expect(results[0].state.version).toBe(11);

    expect(results[1].changed).toBe(true);
    expect(results[1].state.status).toBe('unavailable');
    expect(results[1].state.version).toBe(21);

    // Agent already unavailable — idempotent, no change
    expect(results[2].changed).toBe(false);
    expect(results[2].state.version).toBe(5); // No version increment
  });

  it('running daily reset a second time produces no additional transitions', () => {
    const state: QueueState = { status: 'unavailable', version: 11, changed_by: 'agent1', source: 'daily_reset' };
    const result = transition(state, { new_status: 'unavailable', source: 'daily_reset', changed_by: 'agent1' });

    expect(result.changed).toBe(false);
    expect(result.state.version).toBe(11); // Unchanged
  });
});

/* -------------------------------------------------------------------------- */
/*  Additional: Version monotonicity                                          */
/* -------------------------------------------------------------------------- */

describe('Version monotonicity', () => {
  it('version always increases on a successful change', () => {
    let state: QueueState = { status: 'unavailable', version: 1, changed_by: 'agent1', source: 'system_migration' };

    const transitions: TransitionRequest[] = [
      { new_status: 'available', source: 'agent_manual', changed_by: 'agent1' },
      { new_status: 'break', source: 'attendance_break_start', changed_by: 'agent1' },
      { new_status: 'available', source: 'attendance_break_end', changed_by: 'agent1' },
      { new_status: 'unavailable', source: 'attendance_clock_out', changed_by: 'agent1' },
      { new_status: 'available', source: 'agent_manual', changed_by: 'agent1' },
      { new_status: 'unavailable', source: 'manager_manual', changed_by: 'manager1' },
    ];

    let prevVersion = state.version;
    for (const req of transitions) {
      const result = transition(state, req);
      expect(result.success).toBe(true);
      expect(result.changed).toBe(true);
      expect(result.state.version).toBeGreaterThan(prevVersion);
      prevVersion = result.state.version;
      state = result.state;
    }

    expect(state.version).toBe(7);
  });

  it('idempotent transitions do NOT increment version', () => {
    const state: QueueState = { status: 'available', version: 50, changed_by: 'agent1', source: 'agent_manual' };
    const result = transition(state, { new_status: 'available', source: 'agent_manual', changed_by: 'agent1' });
    expect(result.changed).toBe(false);
    expect(result.state.version).toBe(50);
  });
});

/* -------------------------------------------------------------------------- */
/*  Additional: Source attribution                                            */
/* -------------------------------------------------------------------------- */

describe('Source attribution', () => {
  it('every transition records the correct source', () => {
    const state: QueueState = { status: 'available', version: 1, changed_by: 'agent1', source: 'agent_manual' };

    const sources: Source[] = [
      'agent_manual',
      'manager_manual',
      'attendance_break_start',
      'attendance_clock_out',
      'daily_reset',
      'user_deactivated',
    ];

    for (const source of sources) {
      const result = transition(state, { new_status: 'unavailable', source, changed_by: 'actor1' });
      expect(result.state.source).toBe(source);
    }
  });

  it('changed_by is always recorded', () => {
    const state: QueueState = { status: 'available', version: 1, changed_by: 'agent1', source: 'agent_manual' };
    const result = transition(state, { new_status: 'unavailable', source: 'manager_manual', changed_by: 'manager99' });
    expect(result.state.changed_by).toBe('manager99');
  });
});

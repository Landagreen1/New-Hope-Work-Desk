// src/features/cancellations/__tests__/drawer-controls.test.ts
//
// Feature: policy-follow-up-renewals-cancellations, task 16.7 — the drawer's role visibility, its
// one prominent control, and its audit timeline order.
//
// **Validates: Requirements 17.3, 17.4, 17.7, 17.10, 22.2, 22.3, 25.2**
//
// `CancellationDrawer.tsx` exports the three decisions this file is about as pure functions over
// data — the nine controls, their `visible` and `prominent` flags, and the timeline comparator — so
// nothing is rendered here and no DOM is needed. That is deliberate: a control hidden from a role
// is hidden because `isActionVisibleToRole` said so, and a control is prominent because
// `primaryAction` returned its action, so asserting the data asserts the markup's only input. No
// mock is used and none is needed: the roles are the real `APP_ROLES` values read through the real
// `canAccessRenewals` and `isBroadManagerRole`, which is the only way a Requirement 17.10 gate is
// worth testing, and each role set is asserted before it is looped over so no loop can pass by
// being empty.
//
// The eight fixture worlds are the ones `./derive.test.ts` (task 16.3) built for the same ladder,
// repeated here with the same values so the two suites agree on what reaches each step; each case
// re-asserts the step it reaches, so a drift in either file shows up as a failure rather than as
// two suites quietly testing different cases.
//
// Readings recorded where a criterion leaves something open:
//
//  1. *Requirement 17.10 governs the drawer's controls.* Requirement 22.2 lists Retry Failed
//     Communication among the actions an Agent_Role profile may use on its own record, and
//     Requirement 17.10 hides that control in the drawer from Agent_Role. The narrower of the two
//     is what the drawer renders, so this file asserts the four controls of Requirement 17.10 are
//     absent for `agent`, `customer_service`, and `sales_supervisor` — the three roles Requirement
//     22.5 defines as holding Agent_Role — and present for `manager` and `super_admin`.
//  2. *Visibility is a function of the role alone.* The same nine controls resolve to the same
//     visible set on every one of the eight worlds, so a case's own state can never surface a
//     control the role may not see.
//  3. *A cleared next required action promotes nothing.* Nine controls are still offered and none
//     is prominent, which is Requirement 16.9's em dash cell stated as an affordance.
//  4. *Confirm Cancellation is selectable and never prominent.* It is one of the nine controls of
//     Requirement 17.3 and none of the eight steps of Requirement 17.4.
//  5. *An unreadable event time is not time zero.* Requirement 17.7 orders by event time
//     descending; a value that names no instant sorts after every readable one in both directions
//     rather than to the top of the timeline in one of them.

import { describe, expect, it } from 'vitest';

import { APP_ROLES, canAccessRenewals, isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import type { CancellationEvent } from '../api';
import {
  CANCELLATION_DRAWER_CONTROLS,
  cancellationDrawerControls,
  compareCancellationEvents,
  orderedCancellationEvents,
  prominentCancellationDrawerControl,
  visibleCancellationDrawerControls,
} from '../CancellationDrawer';
import {
  MANAGER_ONLY_ACTIONS,
  NEXT_REQUIRED_ACTIONS,
  PRIMARY_ACTION_STEPS,
  primaryAction,
  primaryActionStep,
} from '../derive';
import type {
  CancellationRowCase,
  CancellationRowContact,
  CancellationRowState,
  NextRequiredAction,
  PrimaryActionStep,
} from '../derive';
import type {
  CommunicationRecord,
  DeliveryResult,
  EscalationRecord,
  ScheduledSend,
} from '../domain/communication-status';
import type { Touchpoint } from '../render/renderMessage';

// ---------------------------------------------------------------------------
// Fixtures — the worlds of `./derive.test.ts`, same values
// ---------------------------------------------------------------------------

const CASE_ID = 'case-0001';

/** The cancellation effective date every world here shares. July 2026 has 31 days. */
const EFFECTIVE_DATE = '2026-07-31';

/** Business dates named by the days remaining they produce against `EFFECTIVE_DATE`. */
const DAY = {
  /** Outside every date window and off every Touchpoint due date. */
  remaining16: '2026-07-15',
  remaining15: '2026-07-16',
} as const;

const PHONE_VALUE = '+13055550147';
const EMAIL_VALUE = 'ana.reyes@example.com';

/** Uncleared: `cleared_at` absent is the whole of Requirement 20.11 as a status reads it. */
const UNCLEARED_ESCALATION: EscalationRecord = {
  id: 'esc-1',
  case_id: CASE_ID,
  reason: 'No Valid Contact',
  raised_at: '2026-07-14T12:00:00.000Z',
};

function phoneContact(overrides: Partial<CancellationRowContact> = {}): CancellationRowContact {
  return {
    id: 'contact-phone-1',
    case_id: CASE_ID,
    channel: 'phone',
    normalized_value: PHONE_VALUE,
    raw_segment: '(305) 555-0147',
    validation_status: 'valid',
    authorization_status: 'Authorized',
    sms_suppressed: false,
    email_suppressed: false,
    ...overrides,
  };
}

function emailContact(overrides: Partial<CancellationRowContact> = {}): CancellationRowContact {
  return {
    id: 'contact-email-1',
    case_id: CASE_ID,
    channel: 'email',
    normalized_value: EMAIL_VALUE,
    raw_segment: EMAIL_VALUE,
    validation_status: 'valid',
    authorization_status: 'Authorized',
    sms_suppressed: false,
    email_suppressed: false,
    ...overrides,
  };
}

function record(
  touchpoint: Touchpoint,
  channel: 'sms' | 'email',
  deliveryResult: DeliveryResult,
): CommunicationRecord {
  return {
    id: `comm-${touchpoint}-${channel}-${deliveryResult}`,
    case_id: CASE_ID,
    contact_id: channel === 'sms' ? 'contact-phone-1' : 'contact-email-1',
    touchpoint,
    channel,
    delivery_result: deliveryResult,
    send_time: '2026-07-16T14:00:00.000Z',
  };
}

function caseRow(overrides: Partial<CancellationRowCase> = {}): CancellationRowCase {
  return {
    id: CASE_ID,
    case_status: 'Open',
    communication_status: null,
    cancellation_effective_date: EFFECTIVE_DATE,
    next_required_action: null,
    customer_name: 'Ana Reyes',
    policy_number: 'POL-1000',
    carrier: 'Acme Mutual',
    cancellation_reason: 'Non-payment',
    amount_due: '412.50',
    assigned_to: null,
    follow_up_deadline: null,
    ...overrides,
  };
}

/**
 * The baseline world: an Open case 16 days out, two valid authorized contacts, one delivered
 * 15-day SMS record, no response, no escalation, no deadline.
 */
function world(overrides: Partial<CancellationRowState> = {}): CancellationRowState {
  return {
    case: caseRow(),
    contacts: [phoneContact(), emailContact()],
    communications: [record(15, 'sms', 'Delivered')],
    scheduledSends: [],
    escalations: [],
    responses: [],
    suppressions: [],
    businessDate: DAY.remaining16,
    ...overrides,
  };
}

/** A world differing from the baseline only in its case columns. */
function caseWorld(
  overrides: Partial<CancellationRowCase>,
  rest: Partial<CancellationRowState> = {},
): CancellationRowState {
  return world({ case: caseRow(overrides), ...rest });
}

function scheduled(touchpoint: Touchpoint, channel: 'sms' | 'email'): ScheduledSend {
  return { touchpoint, channel };
}

/** One world per step of Requirement 17.4, each reaching that step and no earlier one. */
const PRIMARY_ACTION_WORLDS: Record<PrimaryActionStep, CancellationRowState> = {
  // (a) Case_Status is Payment Reported or Verification Pending.
  a: caseWorld({ case_status: 'Payment Reported' }),
  // (b) Case_Status is Reinstatement Pending.
  b: caseWorld({ case_status: 'Reinstatement Pending' }),
  // (c) Zero contact rows whose validation status is valid and whose authorization permits contact.
  c: world({ contacts: [] }),
  // (d) Communication_Status is Failed or Partially Failed, with the current Touchpoint recorded
  //     so that step (f) cannot fire behind it.
  d: world({ businessDate: DAY.remaining15, communications: [record(15, 'sms', 'Failed')] }),
  // (e) Communication_Status is Manual Follow-up Required.
  e: world({ businessDate: DAY.remaining15, escalations: [UNCLEARED_ESCALATION] }),
  // (f) Case_Status is Imported or Open and no record exists for the current Touchpoint.
  f: world({ businessDate: DAY.remaining15, communications: [], scheduledSends: [scheduled(15, 'sms')] }),
  // (g) Case_Status is Reinstated, Cancelled, Invalid, or Duplicate.
  g: caseWorld({ case_status: 'Invalid' }),
  // (h) Every remaining case.
  h: world({ businessDate: DAY.remaining15 }),
};

const ALL_WORLDS: readonly CancellationRowState[] = Object.values(PRIMARY_ACTION_WORLDS);

/** The action each step of Requirement 17.4 produces, read from the criterion's own list. */
const STEP_ACTION: Record<PrimaryActionStep, NextRequiredAction> = Object.fromEntries(
  PRIMARY_ACTION_STEPS.map((entry) => [entry.step, entry.action]),
) as Record<PrimaryActionStep, NextRequiredAction>;

const STEPS: readonly PrimaryActionStep[] = PRIMARY_ACTION_STEPS.map((entry) => entry.step);

// ---------------------------------------------------------------------------
// Roles, enumerated from the real permission module
// ---------------------------------------------------------------------------

/** The three roles Requirement 22.5 defines as holding Agent_Role in this workspace. */
const AGENT_ROLES: readonly AppRole[] = APP_ROLES.filter(
  (role) => canAccessRenewals(role) && !isBroadManagerRole(role),
);
/** The two roles holding Manager_Role: `manager` and `super_admin` (Requirement 22.3). */
const MANAGER_ROLES: readonly AppRole[] = APP_ROLES.filter((role) => isBroadManagerRole(role));
/** Every role that reaches the Policy Follow-up workspace at all. */
const WORKSPACE_ROLES: readonly AppRole[] = APP_ROLES.filter((role) => canAccessRenewals(role));

/** The five controls Requirement 17.10 shows to Agent_Role, in the Requirement 17.3 order. */
const AGENT_CONTROLS: readonly NextRequiredAction[] = [
  'Add Contact Information',
  'Send Reminder Now',
  'Call Customer',
  'Record Customer Response',
  'Mark Resolved',
];

const actionsOf = (state: CancellationRowState, role: AppRole | null): NextRequiredAction[] =>
  visibleCancellationDrawerControls(state, role).map((control) => control.action);

const prominentOf = (state: CancellationRowState, role: AppRole | null) =>
  cancellationDrawerControls(state, role).filter((control) => control.prominent);

// ---------------------------------------------------------------------------
// The nine controls (Requirement 17.3)
// ---------------------------------------------------------------------------

describe('the nine drawer controls', () => {
  it('offers the nine actions of Requirement 17.3 in that order', () => {
    expect(CANCELLATION_DRAWER_CONTROLS).toHaveLength(9);
    expect(CANCELLATION_DRAWER_CONTROLS.map((control) => control.action)).toEqual([
      'Add Contact Information',
      'Send Reminder Now',
      'Retry Failed Communication',
      'Call Customer',
      'Record Customer Response',
      'Verify Payment',
      'Confirm Reinstatement',
      'Confirm Cancellation',
      'Mark Resolved',
    ]);
    // The order is the shared vocabulary, not a second list kept in step by hand.
    expect(CANCELLATION_DRAWER_CONTROLS.map((control) => control.action)).toEqual([
      ...NEXT_REQUIRED_ACTIONS,
    ]);
  });

  it('marks exactly the four manager-only actions and names a section and a hint for each', () => {
    expect([...MANAGER_ONLY_ACTIONS]).toEqual([
      'Verify Payment',
      'Confirm Reinstatement',
      'Confirm Cancellation',
      'Retry Failed Communication',
    ]);
    expect(
      CANCELLATION_DRAWER_CONTROLS.filter((control) => control.managerOnly).map((c) => c.action),
    ).toEqual([
      'Retry Failed Communication',
      'Verify Payment',
      'Confirm Reinstatement',
      'Confirm Cancellation',
    ]);

    for (const control of CANCELLATION_DRAWER_CONTROLS) {
      expect(control.managerOnly).toBe(
        (MANAGER_ONLY_ACTIONS as readonly NextRequiredAction[]).includes(control.action),
      );
      expect(control.section).toBeTruthy();
      expect(control.hint.length).toBeGreaterThan(0);
    }

    // Two controls send on activation; every other one opens the section that performs the write.
    expect(
      CANCELLATION_DRAWER_CONTROLS.filter((control) => control.sends !== null).map((control) => [
        control.action,
        control.sends,
      ]),
    ).toEqual([
      ['Send Reminder Now', 'send_now'],
      ['Retry Failed Communication', 'retry_failed'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Role visibility (Requirements 17.10, 22.2, 22.3)
// ---------------------------------------------------------------------------

describe('the four manager-only controls', () => {
  it('reads the role sets from the permission module rather than from a list here', () => {
    // Asserted before anything loops over them: an empty set would make every case below vacuous.
    expect([...AGENT_ROLES]).toEqual(['agent', 'customer_service', 'sales_supervisor']);
    expect([...MANAGER_ROLES]).toEqual(['manager', 'super_admin']);
    expect([...WORKSPACE_ROLES]).toEqual([
      'agent',
      'manager',
      'customer_service',
      'sales_supervisor',
      'super_admin',
    ]);
    expect(WORKSPACE_ROLES).toHaveLength(AGENT_ROLES.length + MANAGER_ROLES.length);
  });

  it('hides all four from agent, customer_service, and sales_supervisor', () => {
    for (const role of AGENT_ROLES) {
      const visible = actionsOf(world(), role);
      for (const action of MANAGER_ONLY_ACTIONS) expect(visible).not.toContain(action);
      expect(visible).toEqual([...AGENT_CONTROLS]);
      expect(visible).toHaveLength(5);

      // The hidden four are present as controls and marked not visible, not dropped from the data.
      const hidden = cancellationDrawerControls(world(), role).filter((c) => !c.visible);
      expect(hidden.map((control) => control.action).sort()).toEqual(
        [...MANAGER_ONLY_ACTIONS].sort(),
      );
      expect(hidden.every((control) => control.managerOnly)).toBe(true);
      // A control the role cannot see is never the prominent one either.
      expect(hidden.some((control) => control.prominent)).toBe(false);
    }
  });

  it('shows all four to manager and super_admin', () => {
    for (const role of MANAGER_ROLES) {
      const visible = actionsOf(world(), role);
      for (const action of MANAGER_ONLY_ACTIONS) expect(visible).toContain(action);
      expect(visible).toEqual([...NEXT_REQUIRED_ACTIONS]);
      expect(visible).toHaveLength(9);
    }
    // An absent role reads as the unrestricted Manager_Role view; row level security remains the
    // authorization boundary.
    expect(actionsOf(world(), null)).toEqual([...NEXT_REQUIRED_ACTIONS]);
    expect(visibleCancellationDrawerControls(world())).toHaveLength(9);
  });

  it('shows the other five controls to every workspace role', () => {
    const others = CANCELLATION_DRAWER_CONTROLS.filter((control) => !control.managerOnly);
    expect(others.map((control) => control.action)).toEqual([...AGENT_CONTROLS]);

    for (const role of WORKSPACE_ROLES) {
      const visible = actionsOf(world(), role);
      for (const control of others) expect(visible).toContain(control.action);
    }
    // Nothing in the five depends on the role at all, so they hold for every role in the system.
    for (const role of APP_ROLES) {
      const visible = actionsOf(world(), role);
      for (const control of others) expect(visible).toContain(control.action);
    }
  });

  it('decides visibility from the role alone, on every one of the eight worlds', () => {
    // Reading 2: a case's own state can never surface a control its reader may not see.
    for (const state of ALL_WORLDS) {
      for (const role of AGENT_ROLES) expect(actionsOf(state, role)).toEqual([...AGENT_CONTROLS]);
      for (const role of MANAGER_ROLES) {
        expect(actionsOf(state, role)).toEqual([...NEXT_REQUIRED_ACTIONS]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Exactly one prominent control (Requirement 17.4)
// ---------------------------------------------------------------------------

describe('the prominent primary action', () => {
  it('renders exactly one prominent control for each of the eight steps', () => {
    for (const step of STEPS) {
      const state = PRIMARY_ACTION_WORLDS[step];
      for (const role of MANAGER_ROLES) {
        // The world reaches this step for this role, so the case below is about that step.
        expect(primaryActionStep(state, role)).toBe(step);

        const prominent = prominentOf(state, role);
        expect(prominent).toHaveLength(1);
        expect(prominent[0].action).toBe(primaryAction(state, role));
        expect(prominent[0].action).toBe(STEP_ACTION[step]);
        expect(prominent[0].visible).toBe(true);
        // The helper and the filter are the same answer.
        expect(prominentCancellationDrawerControl(state, role)).toEqual(prominent[0]);
      }
    }
  });

  it('renders exactly one prominent control for an Agent_Role reader too', () => {
    for (const step of STEPS) {
      const state = PRIMARY_ACTION_WORLDS[step];
      for (const role of AGENT_ROLES) {
        const prominent = prominentOf(state, role);
        expect(prominent).toHaveLength(1);
        expect(prominent[0].action).toBe(primaryAction(state, role));
        // A hidden step is skipped and the next considered, so the promoted control is one of the
        // five on the reader's screen.
        expect(prominent[0].managerOnly).toBe(false);
        expect(AGENT_CONTROLS).toContain(prominent[0].action);
      }
    }

    // The three manager-only steps are where the two readings differ: a manager is offered the
    // step's own action, an agent the first later step whose control they can see.
    expect(prominentOf(PRIMARY_ACTION_WORLDS.d, 'manager')[0].action).toBe(
      'Retry Failed Communication',
    );
    for (const role of AGENT_ROLES) {
      expect(prominentOf(PRIMARY_ACTION_WORLDS.a, role)[0].action).toBe('Record Customer Response');
      expect(prominentOf(PRIMARY_ACTION_WORLDS.b, role)[0].action).toBe('Record Customer Response');
      expect(prominentOf(PRIMARY_ACTION_WORLDS.d, role)[0].action).toBe('Record Customer Response');
    }
  });

  it('takes the role from the state bundle and lets an explicit role override it', () => {
    const failed = world({
      viewerRole: 'agent',
      businessDate: DAY.remaining15,
      communications: [record(15, 'sms', 'Failed')],
    });
    expect(prominentCancellationDrawerControl(failed)?.action).toBe('Record Customer Response');
    expect(actionsOf(failed, null)).toEqual([...NEXT_REQUIRED_ACTIONS]);
    expect(visibleCancellationDrawerControls(failed)).toHaveLength(5);
    expect(prominentCancellationDrawerControl(failed, 'manager')?.action).toBe(
      'Retry Failed Communication',
    );
  });

  it('promotes nothing where the next required action has been cleared', () => {
    // Reading 3. The three statuses Requirements 19.3, 19.7, and 19.8 clear the action in.
    for (const status of ['Reinstated', 'Cancelled', 'Resolved'] as const) {
      const cleared = caseWorld({ case_status: status, next_required_action: null });
      expect(primaryAction(cleared)).toBeNull();

      for (const role of WORKSPACE_ROLES) {
        expect(prominentOf(cleared, role)).toHaveLength(0);
        expect(prominentCancellationDrawerControl(cleared, role)).toBeNull();
        // Nine controls are still offered; none is promoted.
        expect(cancellationDrawerControls(cleared, role)).toHaveLength(9);
        expect(actionsOf(cleared, role)).toEqual(
          isBroadManagerRole(role) ? [...NEXT_REQUIRED_ACTIONS] : [...AGENT_CONTROLS],
        );
      }
    }
  });

  it('never promotes Confirm Cancellation', () => {
    // Reading 4: one of the nine controls of Requirement 17.3 and none of the eight steps of
    // Requirement 17.4, so it is selectable by a manager and never prominent.
    expect(PRIMARY_ACTION_STEPS.map((entry) => entry.action)).not.toContain('Confirm Cancellation');

    const cleared = caseWorld({ case_status: 'Cancelled', next_required_action: null });
    for (const state of [...ALL_WORLDS, cleared]) {
      for (const role of [...WORKSPACE_ROLES, null]) {
        const controls = cancellationDrawerControls(state, role);
        const confirmCancellation = controls.find((c) => c.action === 'Confirm Cancellation');
        expect(confirmCancellation?.prominent).toBe(false);
        expect(confirmCancellation?.visible).toBe(role === null || isBroadManagerRole(role));
        // At most one control is prominent on any state and role pair.
        expect(controls.filter((control) => control.prominent).length).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The audit timeline order (Requirement 17.7)
// ---------------------------------------------------------------------------

/**
 * One `cancellation_events` row. `event_time` is widened to `string | null` because the stored
 * column can arrive absent, which the row type does not admit and the comparator must still order.
 */
function event(
  sequence: number,
  eventTime: string | null,
  overrides: Partial<CancellationEvent> = {},
): CancellationEvent {
  return {
    id: `event-${sequence}`,
    case_id: CASE_ID,
    actor_id: 'profile-1',
    event_type: 'status_changed',
    detail: null,
    event_time: eventTime as string,
    sequence,
    ...overrides,
  };
}

const T_LATEST = '2026-07-20T09:00:00.000Z';
const T_MIDDLE = '2026-07-18T12:00:00.000Z';
const T_EARLIEST = '2026-07-16T08:00:00.000Z';

/** Distinct sequences, as `bigserial` guarantees, so the order of any two is determined. */
const TIMELINE: readonly CancellationEvent[] = [
  event(10, T_LATEST),
  event(20, T_MIDDLE),
  event(21, T_MIDDLE),
  event(5, T_EARLIEST),
  event(30, null),
  event(31, 'not a timestamp'),
];

const sequences = (events: readonly CancellationEvent[]): number[] =>
  events.map((entry) => entry.sequence);

describe('the audit timeline order', () => {
  it('orders entries sharing an event time by stored insertion order, most recent first', () => {
    const older = event(20, T_MIDDLE);
    const newer = event(21, T_MIDDLE);

    expect(compareCancellationEvents(newer, older)).toBeLessThan(0);
    expect(compareCancellationEvents(older, newer)).toBeGreaterThan(0);
    expect(sequences(orderedCancellationEvents([older, newer]))).toEqual([21, 20]);
    expect(sequences(orderedCancellationEvents([newer, older]))).toEqual([21, 20]);
  });

  it('orders by event time descending ahead of insertion order', () => {
    // The lower sequence wins where its event time is later: the time is the first key.
    const later = event(1, T_LATEST);
    const earlier = event(99, T_EARLIEST);
    expect(compareCancellationEvents(later, earlier)).toBeLessThan(0);
    expect(sequences(orderedCancellationEvents([earlier, later]))).toEqual([1, 99]);
  });

  it('sorts an absent or unreadable event time after every readable one', () => {
    // Reading 5: not time zero, which would sort to the top of the timeline in one direction.
    const readable = event(1, T_EARLIEST);
    const absent = event(99, null);
    const unreadable = event(98, 'not a timestamp');

    expect(compareCancellationEvents(readable, absent)).toBeLessThan(0);
    expect(compareCancellationEvents(absent, readable)).toBeGreaterThan(0);
    expect(compareCancellationEvents(readable, unreadable)).toBeLessThan(0);
    expect(compareCancellationEvents(unreadable, readable)).toBeGreaterThan(0);
    // Two entries with no readable time fall back to insertion order, most recent first.
    expect(compareCancellationEvents(absent, unreadable)).toBeLessThan(0);

    expect(sequences(orderedCancellationEvents(TIMELINE))).toEqual([10, 21, 20, 5, 31, 30]);
  });

  it('returns a new array and leaves the input untouched', () => {
    const input = [...TIMELINE];
    const ordered = orderedCancellationEvents(input);

    expect(ordered).not.toBe(input);
    expect(sequences(input)).toEqual(sequences(TIMELINE));
    expect(sequences(ordered)).toEqual([10, 21, 20, 5, 31, 30]);
    // Ordering an already ordered timeline changes nothing.
    expect(sequences(orderedCancellationEvents(ordered))).toEqual(sequences(ordered));
  });

  it('is a total order over the fixture set', () => {
    for (const left of TIMELINE) {
      expect(compareCancellationEvents(left, left)).toBe(0);
      for (const right of TIMELINE) {
        // Antisymmetry: the two directions carry opposite signs, and cancel where they are equal.
        const forward = Math.sign(compareCancellationEvents(left, right));
        const backward = Math.sign(compareCancellationEvents(right, left));
        expect(forward + backward).toBe(0);
        expect(Math.abs(forward)).toBe(Math.abs(backward));
        // Totality: no two distinct entries compare equal, so the order of any two is determined.
        if (left !== right) expect(forward).not.toBe(0);
      }
    }

    for (const a of TIMELINE) {
      for (const b of TIMELINE) {
        if (compareCancellationEvents(a, b) >= 0) continue;
        for (const c of TIMELINE) {
          // Transitivity.
          if (compareCancellationEvents(b, c) < 0) {
            expect(compareCancellationEvents(a, c)).toBeLessThan(0);
          }
        }
      }
    }
  });
});

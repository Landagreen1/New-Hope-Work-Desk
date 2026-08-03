// src/features/renewals/__tests__/renewal-timeline.test.ts
// Unit tests for the pure renewal timeline merge in `../timeline.ts`, the module
// `RenewalTimeline.tsx` renders and re-exports.
//
// Feature: policy-follow-up-renewals-cancellations, task 2.3
//
// Requirement 5.8 is two rules: every contact entry, status change, assignment
// change, next follow-up date change, requote activity entry, and recorded final
// outcome belongs in the timeline; and the order is event time descending with
// the later-recorded entry first on equal event times. Both are asserted here
// against the pure builder, so neither depends on rendering.
//
// Every timestamp is a literal, so nothing here reads the real clock.
//
// Requirements: 5.8, 1.4

import { describe, expect, it } from 'vitest';
import type { RenewalContact, RenewalEvent, RenewalSmsLog } from '../api';
import { buildRenewalTimeline } from '../timeline';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeContact(overrides: Partial<RenewalContact> = {}): RenewalContact {
  return {
    id: 'contact-1',
    record_id: 'record-1',
    contacted_by: 'profile-1',
    channel: 'call',
    direction: 'outbound',
    outcome: 'Left voicemail',
    notes: 'Called the customer about the renewal premium.',
    occurred_at: '2026-02-10T15:00:00.000Z',
    entry_source: 'manual',
    rc_call_id: null,
    rc_session_id: null,
    rc_recording_content_uri: null,
    evidence_path: null,
    evidence_name: null,
    evidence_reference: null,
    evidence_mime_type: null,
    evidence_size_bytes: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<RenewalEvent> = {}): RenewalEvent {
  return {
    id: 'event-1',
    record_id: 'record-1',
    actor_id: 'profile-1',
    event_type: 'workflow_updated',
    detail: null,
    created_at: '2026-02-10T12:00:00.000Z',
    ...overrides,
  };
}

function makeSmsLog(overrides: Partial<RenewalSmsLog> = {}): RenewalSmsLog {
  return {
    id: 'sms-1',
    record_id: 'record-1',
    phone: '+13055550100',
    message_text: 'Your policy renews soon.',
    trigger_type: 'manual',
    rc_message_id: null,
    rc_batch_id: null,
    delivery_status: 'delivered',
    error_detail: null,
    sent_by: 'profile-1',
    sent_at: '2026-02-10T11:00:00.000Z',
    created_at: '2026-02-10T11:00:00.000Z',
    ...overrides,
  };
}

/** Profile id to display name, so no raw identifier reaches an entry's actor line. */
const ACTOR_NAMES = new Map([
  ['profile-1', 'Dana Reyes'],
  ['profile-2', 'Sam Ortiz'],
]);

// ---------------------------------------------------------------------------
// Requirement 5.8 — every named category is included
// ---------------------------------------------------------------------------

describe('buildRenewalTimeline merges every category Requirement 5.8 names', () => {
  it('classifies contact, status, assignment, follow-up, requote, and outcome rows', () => {
    const entries = buildRenewalTimeline({
      contacts: [makeContact({ occurred_at: '2026-02-10T15:00:00.000Z' })],
      events: [
        makeEvent({ id: 'e-status', detail: { status: 'monitoring' }, created_at: '2026-02-09T09:00:00.000Z' }),
        makeEvent({
          id: 'e-assign',
          event_type: 'manager_assigned',
          detail: { assigned_name: 'Sam Ortiz' },
          created_at: '2026-02-08T09:00:00.000Z',
        }),
        makeEvent({
          id: 'e-follow',
          detail: { next_follow_up_at: '2026-02-20' },
          created_at: '2026-02-07T09:00:00.000Z',
        }),
        makeEvent({
          id: 'e-requote',
          event_type: 'requote_intake_submitted',
          created_at: '2026-02-06T09:00:00.000Z',
        }),
        makeEvent({
          id: 'e-outcome',
          detail: { status: 'renewed', outcome_reason: 'Customer signed' },
          created_at: '2026-02-05T09:00:00.000Z',
        }),
      ],
      actorNames: ACTOR_NAMES,
    });

    expect(entries.map((entry) => entry.kind)).toEqual([
      'contact', 'status', 'assignment', 'follow-up', 'requote', 'outcome',
    ]);
    // Every entry names what happened and who recorded it, with no raw profile id.
    expect(entries.every((entry) => entry.label.length > 0)).toBe(true);
    expect(entries.map((entry) => entry.actor)).not.toContain('profile-1');
  });

  it('includes text messages and keeps an unclassified activity row rather than dropping it', () => {
    const entries = buildRenewalTimeline({
      events: [makeEvent({ id: 'e-import', event_type: 'powerbi_record_updated' })],
      smsLogs: [makeSmsLog()],
    });

    expect(entries.map((entry) => entry.kind)).toEqual(['activity', 'sms']);
    expect(entries[1].notes).toBe('Your policy renews soon.');
  });

  it('hands back the stored evidence reference without resolving it', () => {
    const [entry] = buildRenewalTimeline({
      contacts: [makeContact({
        evidence_path: 'record-1/proof.pdf',
        evidence_name: 'proof.pdf',
        evidence_size_bytes: 2_097_152,
      })],
    });

    expect(entry.evidence).toEqual({ reference: 'record-1/proof.pdf', name: 'proof.pdf', size: '2.0 MB' });
  });
});

// ---------------------------------------------------------------------------
// Requirement 5.8 — ordering
// ---------------------------------------------------------------------------

describe('buildRenewalTimeline ordering', () => {
  it('orders by event time descending across all three sources', () => {
    const entries = buildRenewalTimeline({
      contacts: [makeContact({ id: 'c-old', occurred_at: '2026-02-01T08:00:00.000Z' })],
      events: [makeEvent({ id: 'e-new', created_at: '2026-02-11T08:00:00.000Z' })],
      smsLogs: [makeSmsLog({ id: 's-mid', sent_at: '2026-02-05T08:00:00.000Z', created_at: '2026-02-05T08:00:00.000Z' })],
    });

    expect(entries.map((entry) => entry.id)).toEqual(['event-e-new', 'sms-s-mid', 'contact-c-old']);
  });

  it('places the later-recorded entry first when event times are equal', () => {
    // Both messages were sent at the same instant; only the recorded time differs,
    // and the later-recorded row is handed in second so the tie-break has to act.
    const entries = buildRenewalTimeline({
      smsLogs: [
        makeSmsLog({ id: 's-early', sent_at: '2026-02-10T11:00:00.000Z', created_at: '2026-02-10T11:00:05.000Z' }),
        makeSmsLog({ id: 's-late', sent_at: '2026-02-10T11:00:00.000Z', created_at: '2026-02-10T11:00:09.000Z' }),
      ],
    });

    expect(entries.map((entry) => entry.id)).toEqual(['sms-s-late', 'sms-s-early']);
  });

  it('keeps the most-recent-first input order for rows carrying no distinct recorded time', () => {
    // `listRenewalEvents` returns rows most recent first, so on an exact tie the
    // row the database returned as the later record stays ahead of its tie.
    const entries = buildRenewalTimeline({
      events: [
        makeEvent({ id: 'e-second', created_at: '2026-02-10T12:00:00.000Z' }),
        makeEvent({ id: 'e-first', created_at: '2026-02-10T12:00:00.000Z' }),
      ],
    });

    expect(entries.map((entry) => entry.id)).toEqual(['event-e-second', 'event-e-first']);
  });

  it('sorts an entry with no readable event time last and leaves the inputs unmutated', () => {
    const contacts = [
      makeContact({ id: 'c-unreadable', occurred_at: 'not a timestamp' }),
      makeContact({ id: 'c-dated', occurred_at: '2026-02-03T08:00:00.000Z' }),
    ];
    const entries = buildRenewalTimeline({ contacts });

    expect(entries.map((entry) => entry.id)).toEqual(['contact-c-dated', 'contact-c-unreadable']);
    expect(entries[1].eventTimeValue).toBeNull();
    expect(contacts.map((contact) => contact.id)).toEqual(['c-unreadable', 'c-dated']);
  });

  it('returns an empty list when no rows are supplied', () => {
    expect(buildRenewalTimeline({})).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import type { Notification } from '../types';
import {
  buildClaimNotification,
  buildFlagNotification,
  getUnreadCount,
  markNotificationRead,
  dismissNotification,
} from '../notification-helpers';

// Feature: customer-intake-claim-duplicate-quote
// **Validates: Requirements 19.1, 20.1, 21.1**

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'notif-1',
    recipient_id: 'user-1',
    notification_type: 'quote_assigned',
    title: 'Test Notification',
    body: 'Test body',
    metadata: {},
    action_url: null,
    is_read: false,
    is_dismissed: false,
    created_at: new Date().toISOString(),
    read_at: null,
    dismissed_at: null,
    ...overrides,
  };
}

describe('Claim notification structure', () => {
  it('agent notification has notification_type=quote_assigned', () => {
    const { agentNotification } = buildClaimNotification('John Doe', 'Agent Smith', 'quote-123');
    expect(agentNotification.notification_type).toBe('quote_assigned');
  });

  it('CS notification has notification_type=intake_claimed', () => {
    const { csNotification } = buildClaimNotification('John Doe', 'Agent Smith', 'quote-123');
    expect(csNotification.notification_type).toBe('intake_claimed');
  });

  it('agent notification includes customer name and quote ID in metadata', () => {
    const { agentNotification } = buildClaimNotification('Jane Roe', 'Agent Jones', 'quote-456');
    expect(agentNotification.metadata).toMatchObject({
      quote_id: 'quote-456',
      customer_name: 'Jane Roe',
      agent_name: 'Agent Jones',
    });
  });

  it('CS notification includes agent name in metadata and body', () => {
    const { csNotification } = buildClaimNotification('Jane Roe', 'Agent Jones', 'quote-456');
    expect(csNotification.metadata).toMatchObject({ agent_name: 'Agent Jones' });
    expect(csNotification.body).toContain('Agent Jones');
  });

  it('both notifications start as unread and not dismissed', () => {
    const { agentNotification, csNotification } = buildClaimNotification('Customer', 'Agent', 'q-1');
    expect(agentNotification.is_read).toBe(false);
    expect(agentNotification.is_dismissed).toBe(false);
    expect(csNotification.is_read).toBe(false);
    expect(csNotification.is_dismissed).toBe(false);
  });

  it('action_url navigates to the quote detail page', () => {
    const { agentNotification, csNotification } = buildClaimNotification('Customer', 'Agent', 'q-789');
    expect(agentNotification.action_url).toBe('/tools/quotes/q-789');
    expect(csNotification.action_url).toBe('/tools/quotes/q-789');
  });
});

describe('Flag notification structure', () => {
  it('has notification_type=duplicate_flagged', () => {
    const notif = buildFlagNotification('Flagged Co', 'Original Co', 'Agent X', 'review-1');
    expect(notif.notification_type).toBe('duplicate_flagged');
  });

  it('body includes flagged name, original name, and agent name', () => {
    const notif = buildFlagNotification('Flagged Co', 'Original Co', 'Agent X', 'review-1');
    expect(notif.body).toContain('Flagged Co');
    expect(notif.body).toContain('Original Co');
    expect(notif.body).toContain('Agent X');
  });

  it('metadata includes review_id for navigation', () => {
    const notif = buildFlagNotification('A', 'B', 'C', 'review-99');
    expect(notif.metadata).toMatchObject({ review_id: 'review-99' });
  });

  it('action_url navigates to the duplicate review screen', () => {
    const notif = buildFlagNotification('A', 'B', 'C', 'review-42');
    expect(notif.action_url).toBe('/tools/quotes/duplicate-review/review-42');
  });

  it('starts unread and not dismissed (should be created for all managers)', () => {
    const notif = buildFlagNotification('A', 'B', 'C', 'review-1');
    expect(notif.is_read).toBe(false);
    expect(notif.is_dismissed).toBe(false);
  });
});

describe('Mark as read state transition', () => {
  it('transitions is_read from false to true', () => {
    const notif = makeNotification({ is_read: false, read_at: null });
    const updated = markNotificationRead(notif);
    expect(updated.is_read).toBe(true);
  });

  it('sets read_at timestamp', () => {
    const notif = makeNotification({ is_read: false, read_at: null });
    const before = Date.now();
    const updated = markNotificationRead(notif);
    const readTime = new Date(updated.read_at!).getTime();
    expect(readTime).toBeGreaterThanOrEqual(before);
    expect(readTime).toBeLessThanOrEqual(Date.now());
  });

  it('does not mutate the original notification', () => {
    const notif = makeNotification({ is_read: false });
    markNotificationRead(notif);
    expect(notif.is_read).toBe(false);
    expect(notif.read_at).toBeNull();
  });
});

describe('Dismiss state transition', () => {
  it('transitions is_dismissed from false to true', () => {
    const notif = makeNotification({ is_dismissed: false, dismissed_at: null });
    const updated = dismissNotification(notif);
    expect(updated.is_dismissed).toBe(true);
  });

  it('sets dismissed_at timestamp', () => {
    const notif = makeNotification({ is_dismissed: false, dismissed_at: null });
    const before = Date.now();
    const updated = dismissNotification(notif);
    const dismissedTime = new Date(updated.dismissed_at!).getTime();
    expect(dismissedTime).toBeGreaterThanOrEqual(before);
    expect(dismissedTime).toBeLessThanOrEqual(Date.now());
  });

  it('does not mutate the original notification', () => {
    const notif = makeNotification({ is_dismissed: false });
    dismissNotification(notif);
    expect(notif.is_dismissed).toBe(false);
    expect(notif.dismissed_at).toBeNull();
  });
});

describe('Unread count calculation', () => {
  it('counts only notifications where is_read=false AND is_dismissed=false', () => {
    const notifications: Notification[] = [
      makeNotification({ id: '1', is_read: false, is_dismissed: false }),
      makeNotification({ id: '2', is_read: true, is_dismissed: false }),
      makeNotification({ id: '3', is_read: false, is_dismissed: true }),
      makeNotification({ id: '4', is_read: true, is_dismissed: true }),
      makeNotification({ id: '5', is_read: false, is_dismissed: false }),
    ];
    expect(getUnreadCount(notifications)).toBe(2);
  });

  it('returns 0 for an empty list', () => {
    expect(getUnreadCount([])).toBe(0);
  });

  it('returns 0 when all notifications are read', () => {
    const notifications: Notification[] = [
      makeNotification({ id: '1', is_read: true }),
      makeNotification({ id: '2', is_read: true }),
    ];
    expect(getUnreadCount(notifications)).toBe(0);
  });

  it('returns 0 when all notifications are dismissed', () => {
    const notifications: Notification[] = [
      makeNotification({ id: '1', is_dismissed: true }),
      makeNotification({ id: '2', is_dismissed: true }),
    ];
    expect(getUnreadCount(notifications)).toBe(0);
  });

  it('counts all when none are read or dismissed', () => {
    const notifications: Notification[] = [
      makeNotification({ id: '1' }),
      makeNotification({ id: '2' }),
      makeNotification({ id: '3' }),
    ];
    expect(getUnreadCount(notifications)).toBe(3);
  });

  it('dismissed notifications do not count even if is_read is false', () => {
    const notifications: Notification[] = [
      makeNotification({ id: '1', is_read: false, is_dismissed: true }),
    ];
    expect(getUnreadCount(notifications)).toBe(0);
  });
});

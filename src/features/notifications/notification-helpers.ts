/**
 * Pure helper functions for notification construction and state management.
 * These functions are used by UI components and tests to build notification
 * shapes and compute derived notification state.
 *
 * Requirements: 19.1, 20.1, 21.1
 */

import type { Notification, NotificationType } from './types';

/**
 * Build a claim notification payload for the assigned Agent (quote_assigned)
 * and the CS creator (intake_claimed).
 */
export function buildClaimNotification(
  intakeName: string,
  agentName: string,
  quoteId: string,
): { agentNotification: Omit<Notification, 'id' | 'recipient_id' | 'created_at'>; csNotification: Omit<Notification, 'id' | 'recipient_id' | 'created_at'> } {
  return {
    agentNotification: {
      notification_type: 'quote_assigned',
      title: 'New Quote Assigned',
      body: `${intakeName} — assigned to you`,
      metadata: { quote_id: quoteId, customer_name: intakeName, agent_name: agentName },
      action_url: `/tools/quotes/${quoteId}`,
      is_read: false,
      is_dismissed: false,
      read_at: null,
      dismissed_at: null,
    },
    csNotification: {
      notification_type: 'intake_claimed',
      title: 'Intake Claimed',
      body: `${intakeName} claimed by ${agentName}`,
      metadata: { quote_id: quoteId, agent_name: agentName, claimed_at: new Date().toISOString() },
      action_url: `/tools/quotes/${quoteId}`,
      is_read: false,
      is_dismissed: false,
      read_at: null,
      dismissed_at: null,
    },
  };
}

/**
 * Build a duplicate flag notification payload for all managers.
 */
export function buildFlagNotification(
  flaggedName: string,
  originalName: string,
  agentName: string,
  reviewId: string,
): Omit<Notification, 'id' | 'recipient_id' | 'created_at'> {
  return {
    notification_type: 'duplicate_flagged',
    title: 'Duplicate Quote Flagged',
    body: `${flaggedName} flagged as duplicate of ${originalName} by ${agentName}`,
    metadata: { review_id: reviewId, flagged_name: flaggedName, original_name: originalName, agent_name: agentName },
    action_url: `/tools/quotes/duplicate-review/${reviewId}`,
    is_read: false,
    is_dismissed: false,
    read_at: null,
    dismissed_at: null,
  };
}

/**
 * Count unread notifications (not read AND not dismissed).
 */
export function getUnreadCount(notifications: Notification[]): number {
  return notifications.filter((n) => !n.is_read && !n.is_dismissed).length;
}

/**
 * Mark a notification as read, returning a new object with updated state.
 */
export function markNotificationRead(notification: Notification): Notification {
  return {
    ...notification,
    is_read: true,
    read_at: new Date().toISOString(),
  };
}

/**
 * Dismiss a notification, returning a new object with updated state.
 */
export function dismissNotification(notification: Notification): Notification {
  return {
    ...notification,
    is_dismissed: true,
    dismissed_at: new Date().toISOString(),
  };
}

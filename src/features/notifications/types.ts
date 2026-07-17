/**
 * Notification types for the New Hope Work Desk notification system.
 * Requirements: 19.1, 20.1, 21.1
 */

export type NotificationType =
  | 'quote_assigned'
  | 'intake_claimed'
  | 'duplicate_flagged'
  | 'duplicate_resolved'
  | 'intake_updated'
  | 'quote_reassigned';

export interface Notification {
  id: string;
  recipient_id: string;
  notification_type: NotificationType;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  action_url: string | null;
  is_read: boolean;
  is_dismissed: boolean;
  created_at: string;
  read_at: string | null;
  dismissed_at: string | null;
}

'use client';

import { getSupabase } from '../nhwd-shared/client';
import type { Notification } from './types';
import type { RealtimeChannel } from '@supabase/supabase-js';

function throwIfError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || 'The request could not be completed.');
}

/** Get all unread notifications for the current user */
export async function getUnreadNotifications(): Promise<Notification[]> {
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('recipient_id', user.id)
    .eq('is_dismissed', false)
    .order('created_at', { ascending: false })
    .limit(50);
  throwIfError(error);
  return (data ?? []) as Notification[];
}

/** Mark a notification as read */
export async function markAsRead(notificationId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', notificationId);
  throwIfError(error);
}

/** Dismiss a notification (hide from list) */
export async function dismissNotification(notificationId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('notifications')
    .update({ is_dismissed: true, dismissed_at: new Date().toISOString() })
    .eq('id', notificationId);
  throwIfError(error);
}

/** Subscribe to new notifications for the current user via Supabase Realtime */
export function subscribeToNotifications(
  userId: string,
  onNewNotification: (notification: Notification) => void,
): RealtimeChannel {
  const supabase = getSupabase();
  const channel = supabase
    .channel(`notifications:${userId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${userId}`,
      },
      (payload) => {
        onNewNotification(payload.new as Notification);
      },
    )
    .subscribe();

  return channel;
}

/** Subscribe to rotation state changes (for turn holder display updates) */
export function subscribeToRotationChanges(
  onRotationChange: (newState: { kind: string; current_profile_id: string }) => void,
): RealtimeChannel {
  const supabase = getSupabase();
  const channel = supabase
    .channel('rotation_state_changes')
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'rotation_state',
      },
      (payload) => {
        onRotationChange(payload.new as { kind: string; current_profile_id: string });
      },
    )
    .subscribe();

  return channel;
}

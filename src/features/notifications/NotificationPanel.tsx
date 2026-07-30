'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { useRouter } from 'next/navigation';

import type { ProfileLite } from '../nhwd-shared/client';
import {
  dismissNotification,
  getUnreadNotifications,
  markAllAsRead,
  markAsRead,
  subscribeToNotifications,
} from './api';
import type { Notification } from './types';

interface NotificationPanelProps {
  profile: ProfileLite;
}

/** Format a timestamp as relative time (e.g. "5 min ago") */
function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(isoString).toLocaleDateString();
}

export function NotificationPanel({ profile }: NotificationPanelProps) {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  // Load notifications on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await getUnreadNotifications();
        if (!cancelled) setNotifications(data);
      } catch {
        // Silently fail on initial load — notifications are non-critical
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Subscribe to new notifications via Supabase Realtime
  useEffect(() => {
    const channel = subscribeToNotifications(profile.id, (newNotification) => {
      setNotifications((prev) => [newNotification, ...prev]);
    });

    return () => {
      channel.unsubscribe();
    };
  }, [profile.id]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleDismiss = useCallback(async (notificationId: string) => {
    try {
      await dismissNotification(notificationId);
      setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
    } catch {
      // Silently fail — user can retry
    }
  }, []);

  const handleMarkAllRead = useCallback(async () => {
    try {
      await markAllAsRead();
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, is_read: true, read_at: new Date().toISOString() })),
      );
    } catch {
      // Silently fail
    }
  }, []);

  const handleClickNotification = useCallback(
    async (notification: Notification) => {
      // Mark as read on click
      if (!notification.is_read) {
        try {
          await markAsRead(notification.id);
          setNotifications((prev) =>
            prev.map((n) =>
              n.id === notification.id ? { ...n, is_read: true } : n,
            ),
          );
        } catch {
          // Non-blocking
        }
      }
      // Navigate if there's an action URL
      if (notification.action_url) {
        setIsOpen(false);
        router.push(notification.action_url);
      }
    },
    [router],
  );

  return (
    <div ref={panelRef} className="relative">
      {/* Bell icon toggle */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="relative grid h-10 w-10 place-items-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-[#223f7a]/30 hover:bg-[#eef3fb] hover:text-[#223f7a] focus:outline-none focus:ring-2 focus:ring-[#223f7a] focus:ring-offset-2"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-black text-white shadow-sm ring-2 ring-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-3 w-[min(400px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl ring-1 ring-black/5">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-[#223f7a] to-[#2d5299] px-5 py-3.5">
            <h3 className="text-sm font-black text-white">Notifications</h3>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => void handleMarkAllRead()}
                className="rounded-lg bg-white/20 px-2.5 py-1 text-[11px] font-bold text-white/90 transition hover:bg-white/30"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div className="max-h-[420px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <Bell className="mx-auto h-8 w-8 text-slate-300" />
                <p className="mt-2 text-sm font-bold text-slate-400">No notifications</p>
                <p className="mt-1 text-xs text-slate-400">You're all caught up</p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {notifications.map((notification) => (
                  <li
                    key={notification.id}
                    onClick={() => void handleClickNotification(notification)}
                    className={`relative flex gap-3 px-5 py-3.5 transition cursor-pointer ${
                      notification.is_read
                        ? 'bg-white hover:bg-slate-50'
                        : 'bg-blue-50/60 hover:bg-blue-50'
                    }`}
                  >
                    {/* Unread indicator */}
                    {!notification.is_read && (
                      <span className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-[#223f7a] ring-2 ring-blue-100" />
                    )}

                    <div className="min-w-0 flex-1">
                      <p className={`text-sm ${notification.is_read ? 'font-semibold text-slate-700' : 'font-black text-slate-900'}`}>
                        {notification.title}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-600 line-clamp-2">
                        {notification.body}
                      </p>
                      <p className="mt-1.5 text-[11px] font-semibold text-slate-400">
                        {formatRelativeTime(notification.created_at)}
                      </p>
                    </div>

                    {/* Dismiss button */}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void handleDismiss(notification.id); }}
                      className="shrink-0 self-start rounded-lg p-1.5 text-slate-300 transition hover:bg-slate-100 hover:text-slate-600"
                      aria-label="Dismiss notification"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

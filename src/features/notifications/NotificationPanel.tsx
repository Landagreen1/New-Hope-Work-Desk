'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { useRouter } from 'next/navigation';

import type { ProfileLite } from '../nhwd-shared/client';
import {
  dismissNotification,
  getUnreadNotifications,
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

  const handleAction = useCallback(
    async (notification: Notification) => {
      try {
        await markAsRead(notification.id);
        setNotifications((prev) =>
          prev.map((n) =>
            n.id === notification.id ? { ...n, is_read: true } : n,
          ),
        );
      } catch {
        // Non-blocking — navigate anyway
      }

      if (notification.action_url) {
        setIsOpen(false);
        router.push(notification.action_url);
      }
    },
    [router],
  );

  const handleDismiss = useCallback(async (notificationId: string) => {
    try {
      await dismissNotification(notificationId);
      setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
    } catch {
      // Silently fail — user can retry
    }
  }, []);

  return (
    <div ref={panelRef} className="relative">
      {/* Bell icon toggle */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="relative rounded-full p-2 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#223f7a] focus:ring-offset-2"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(380px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          {/* Header */}
          <div className="border-b border-slate-100 bg-gradient-to-r from-[#eef3fb] to-white px-4 py-3">
            <h3 className="text-sm font-black text-slate-800">Notifications</h3>
          </div>

          {/* Notification list */}
          <div className="max-h-[400px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-slate-500">
                No notifications
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {notifications.map((notification) => (
                  <li
                    key={notification.id}
                    className={`relative flex gap-3 px-4 py-3 transition ${
                      notification.is_read
                        ? 'bg-white'
                        : 'bg-blue-50/50'
                    }`}
                  >
                    {/* Unread indicator */}
                    {!notification.is_read && (
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-blue-500" />
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-800">
                        {notification.title}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-600 line-clamp-2">
                        {notification.body}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-400">
                        {formatRelativeTime(notification.created_at)}
                      </p>

                      {notification.action_url && (
                        <button
                          type="button"
                          onClick={() => handleAction(notification)}
                          className="mt-1.5 rounded-lg bg-[#223f7a] px-3 py-1 text-xs font-bold text-white transition hover:bg-[#1a3263]"
                        >
                          Open
                        </button>
                      )}
                    </div>

                    {/* Dismiss button */}
                    <button
                      type="button"
                      onClick={() => handleDismiss(notification.id)}
                      className="shrink-0 self-start rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
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

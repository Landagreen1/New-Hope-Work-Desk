'use client';

import { useEffect, useState } from 'react';

import { getCurrentProfile, type ProfileLite } from '../nhwd-shared/client';
import { NotificationPanel } from './NotificationPanel';

/**
 * Client wrapper that renders the NotificationPanel only when the user is
 * authenticated. It fetches the current profile on mount and subscribes to
 * real-time notifications via the inner component.
 *
 * Positioned in the app header zone as a fixed element so it remains
 * accessible across all pages without modifying the monolithic WorkDeskApp.
 */
export function NotificationPanelWrapper() {
  const [profile, setProfile] = useState<ProfileLite | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const p = await getCurrentProfile();
      if (!cancelled) setProfile(p);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (!profile) return null;

  return (
    <div className="fixed right-[340px] top-[14px] z-40 hidden sm:block">
      <NotificationPanel profile={profile} />
    </div>
  );
}

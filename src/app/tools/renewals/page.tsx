export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';

import { canAccessRenewals } from '@/lib/permissions';
import { requireToolProfile } from '@/lib/tool-session';

// The Renewals workspace now lives as the first tab of `/tools/policy-follow-up`. This route is
// kept as a thin redirect so existing links and bookmarks keep resolving.
export default async function Page() {
  // Requirements 2.5 and 2.9: the role check runs in server-side code BEFORE the redirect, so a
  // profile `canAccessRenewals` rejects is denied here (`requireToolProfile` redirects it to `/`)
  // and reads zero renewal rows, rather than being forwarded to a page it also cannot see.
  // Both calls throw to unwind, so neither may sit inside a `try` block that would swallow them.
  await requireToolProfile(canAccessRenewals);

  redirect('/tools/policy-follow-up');
}

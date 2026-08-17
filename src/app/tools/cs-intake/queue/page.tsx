/**
 * Retired route: the standalone Sales Intake Queue.
 *
 * The queue itself is not gone — it is work, so it now lives as the Intake section
 * of My Desk, where the badge sits next to the rest of an agent's workload. What is
 * gone is this as a *separate destination*: it rendered the same `IntakeQueue`
 * component that the sidebar's Intake Queue and the Customer Service module's Sales
 * Queue both rendered, which is three ways into one screen.
 *
 * Kept as a redirect rather than deleted, because a bookmark or a browser history
 * entry pointing here should land the employee on the queue rather than on a 404.
 * `?desk=intake` is read by the work desk so the redirect opens the section the URL
 * was asking for, not merely the desk.
 */

import { redirect } from 'next/navigation';

export default function Page() {
  redirect('/?desk=intake');
}

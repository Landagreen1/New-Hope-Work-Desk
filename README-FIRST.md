# New Hope Work Desk v0.9.4.1 — Download Package

This ZIP is a **drop-in update package** for the current v0.9.3 production repository. It contains replacement files in their correct project paths, three ordered Supabase migrations, verification SQL, and copy scripts.

## Included features

- Guaranteed dashboard refresh every 60 seconds, plus Realtime, focus, tab-return, and reconnect refreshes.
- Safe **Delete User** action that removes access while preserving historical records.
- Dealer/source-specific salespeople; selection is required only when the selected source has active salespeople.
- **Quotes Database** rename, no quote-count badge, and date/status/update filters.
- New Agent **My Team** interaction view.
- New Agent **Manual Workload** quick action for Activations and Changes without moving the Additional Workload queue.

## Important

1. This update expects the v0.9.3 Supabase changes to already be installed.
2. Run `v0.9.4a` and `v0.9.4b` as **two separate Supabase SQL Editor executions**. Then run `v0.9.4c` to apply the salesperson-optional rule.
3. Do not deploy the frontend until all applicable SQL migrations succeed.
4. When a source has active salespeople, an agent must select one. A source with no active salespeople can still be quoted without a salesperson.
5. Existing historical quotes remain available and display **Not recorded** when no salesperson was stored previously.

Continue with `UPGRADE-v0.9.4.1.md` for the exact sequence.

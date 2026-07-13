# v0.9.4.1 Production Test Checklist

## Refresh
- [ ] Realtime updates still work.
- [ ] A change made in another browser appears within 60 seconds.
- [ ] Returning to a hidden tab refreshes immediately.
- [ ] Reconnecting to the internet refreshes immediately.
- [ ] Header shows the last updated time.

## Salespeople
- [ ] Manager can add a salesperson under a source.
- [ ] Manager can deactivate/reactivate a salesperson.
- [ ] Quote forms show only active salespeople for the selected source.
- [ ] Changing source clears the previous salesperson.
- [ ] Source with one salesperson auto-selects that person.
- [ ] Source with no active salesperson allows submission without a salesperson.
- [ ] Source with active salespeople requires a salesperson selection.
- [ ] Salesperson follows Active -> Price Sent -> Sold/Not Sold.
- [ ] Rescue timer quote retains the salesperson after claim/steal.

## Quotes Database and My Team
- [ ] Agent and Manager navigation says Quotes Database with no quote-count badge.
- [ ] Today/status/update filters work.
- [ ] Search finds customer, source, salesperson, and agent.
- [ ] My Team defaults to today and newest interaction first.
- [ ] Opening a My Team interaction opens the shared quote log.

## Manual Workload
- [ ] Agent can log linked Activation or Change outside their workload turn.
- [ ] Agent can log Old / Not in System workload.
- [ ] Additional Workload current agent and queue order do not move.
- [ ] Manual Activation updates linked quote to Sold when applicable.
- [ ] Manual Change leaves quote status unchanged.
- [ ] Manual workload can be completed and can use Customer Service overflow.

## User deletion
- [ ] Delete requires a reason and confirmation.
- [ ] Deleted user cannot sign in.
- [ ] Deleted user is removed from rotations.
- [ ] Historical quotes still show the employee name.
- [ ] Self-deletion is blocked.
- [ ] Final Manager deletion is blocked.
- [ ] Users with active work or Pending Pricing cannot be deleted.

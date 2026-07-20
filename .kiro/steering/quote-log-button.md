# Quote Log Button Rule

Every view in the application that displays a list of quotes (regardless of status, context, or user role) MUST include a "Log" button/action for each quote row. This button opens the Quote Activity timeline modal showing the full event history for that quote.

## Requirements

- The Log button must appear in the Actions column of every quote table/list.
- It applies to: Quotes Database, My Quotes panel, Team Quotes panel, Intake Queue (converted rows), Reports with quote rows, and any future quote list views.
- The Log button should open the `QuoteActivityModal` (from `src/features/cs-intake/QuoteActivityModal.tsx`) passing the `sourceWorkItemId` (or equivalent work_item_id).
- The button should be visible to all roles (agent, customer_service, manager).
- This is a non-negotiable UX standard: if quotes are listed, the Log action must be accessible.

## Implementation Pattern

```tsx
<button onClick={() => openQuoteLog(row.sourceWorkItemId)}>Log</button>
```

The modal renders the full timeline with colored dots, icons, and intake data (drivers, vehicles, coverage) when available.

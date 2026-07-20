# Bugfix Requirements Document

## Introduction

The quote sold/not-sold outcome system has two interrelated defects: (1) agents cannot revisit their own finalized quotes to change the outcome once it has been set — `sold` and `not_sold` are terminal states with only a narrow recovery path from `not_sold → sold` via a dedicated RPC, and (2) reporting date attribution uses `quote_created_at` rather than the canonical `finalized_at` timestamp, meaning outcomes appear on the wrong day in downstream reports. This rework generalizes the outcome-change capability and ensures `finalized_at` is consistently treated as the reporting date.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN an agent has a quote outcome with `decision = 'sold'` AND the customer cancels or the sale falls through THEN the system provides no mechanism to change the outcome back to `not_sold` — the agent is stuck with an incorrect sold record.

1.2 WHEN an agent has a quote outcome with `decision = 'not_sold'` AND the `convert_my_not_sold_quote_to_sold` RPC succeeds THEN the system correctly converts to sold, but this is the ONLY permitted outcome change — there is no generalized bidirectional outcome change.

1.3 WHEN a quote outcome is finalized (either sold or not_sold) THEN the system treats `sold` and `not_sold` as absolute terminal states in `QUOTE_TRANSITIONS` with no outbound transitions, preventing any UI-driven outcome correction.

1.4 WHEN reporting queries aggregate sold/not-sold outcomes by date THEN the system attributes the outcome to `quote_created_at` (the day the quote was originally taken) instead of `finalized_at` (the day the outcome was actually determined), causing outcomes to appear under the wrong reporting period.

### Expected Behavior (Correct)

2.1 WHEN an agent owns a finalized quote outcome with `decision = 'sold'` AND provides a mandatory note explaining the change THEN the system SHALL allow changing the decision to `not_sold`, updating `finalized_at` to the current timestamp and requiring a `not_sold_reason`.

2.2 WHEN an agent owns a finalized quote outcome with `decision = 'not_sold'` AND provides a mandatory note explaining the change THEN the system SHALL allow changing the decision to `sold`, updating `finalized_at` to the current timestamp and clearing `not_sold_reason` / `not_sold_reason_other`.

2.3 WHEN any quote outcome decision is changed (sold → not_sold OR not_sold → sold) THEN the system SHALL log the change in `work_item_events` with `event_type = 'outcome_change'`, recording the previous decision, new decision, and the agent's note in the `details` JSON.

2.4 WHEN any quote outcome decision is changed THEN the system SHALL log an entry in `audit_log` with action `'change_quote_outcome'`, capturing `old_value` (previous decision + reason), `new_value` (new decision + finalized_at), and the agent's note as `reason`.

2.5 WHEN reporting queries aggregate sold/not-sold outcomes THEN the system SHALL use `finalized_at` as the canonical date for period attribution, never `quote_created_at`.

2.6 WHEN an agent views their finalized quote outcomes in the UI THEN the system SHALL display a "Change Outcome" action button on each of their own outcomes (both sold and not_sold), which opens a modal requiring a note and (if changing to not_sold) a reason selection.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a quote is in any non-terminal status (assigned, quoting, pricing_sent, activation_pending, activated) THEN the system SHALL CONTINUE TO enforce the existing `QUOTE_TRANSITIONS` forward-only progression for operational quote flow.

3.2 WHEN the existing `convert_my_not_sold_quote_to_sold` RPC is called THEN the system SHALL CONTINUE TO function correctly for backward compatibility until it is deprecated or replaced by the new generalized function.

3.3 WHEN a quote outcome belongs to a different agent THEN the system SHALL CONTINUE TO prevent that agent from modifying the outcome — only the owning agent can change their own outcomes.

3.4 WHEN a quote outcome is changed THEN the system SHALL CONTINUE TO preserve all original fields (`quote_created_at`, `assigned_at`, `accepted_at`, `price_sent_at`, `source_work_item_id`, `assigned_profile_id`) — only `decision`, `finalized_at`, `not_sold_reason`, and `not_sold_reason_other` may change.

3.5 WHEN an inactive or non-agent profile attempts to change a quote outcome THEN the system SHALL CONTINUE TO reject the request — only active agents may perform outcome changes.

---

## Bug Condition (Formal)

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type QuoteOutcomeChangeRequest
  OUTPUT: boolean

  // The bug manifests when an agent wants to change the outcome of their own
  // finalized quote but the system blocks it (sold is terminal, not_sold only
  // allows conversion to sold via a narrow RPC)
  RETURN (X.current_decision = 'sold' AND X.desired_decision = 'not_sold')
      OR (X.current_decision = 'not_sold' AND X.desired_decision = 'sold' AND X.uses_generalized_path = true)
END FUNCTION
```

```pascal
// Property: Fix Checking — Bidirectional outcome change
FOR ALL X WHERE isBugCondition(X) DO
  result ← changeQuoteOutcome'(X)
  ASSERT result.decision = X.desired_decision
     AND result.finalized_at >= X.request_time
     AND audit_log_contains(X.outcome_id, X.previous_decision, X.desired_decision, X.note)
     AND work_item_event_logged(X.source_work_item_id, 'outcome_change')
END FOR
```

```pascal
// Property: Preservation Checking — Non-buggy inputs unchanged
FOR ALL X WHERE NOT isBugCondition(X) DO
  // Operational transitions, other agents' outcomes, inactive profiles
  ASSERT F(X) = F'(X)
END FOR
```

```pascal
// Property: Reporting Date Attribution
FOR ALL outcomes O IN quote_outcomes DO
  ASSERT report_period(O) = date_trunc('day', O.finalized_at)
  // Never quote_created_at
END FOR
```

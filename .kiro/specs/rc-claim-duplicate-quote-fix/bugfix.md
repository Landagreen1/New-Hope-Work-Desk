# Bugfix Requirements Document

## Introduction

When a single agent claims a RingCentral-sourced intake from the IntakeQueue, the system creates a duplicate quote. The `claim_ringcentral_intake` RPC creates an `operational_quotes` record but does not update the legacy `cs_intake_submissions` table that the UI reads from. The UI then shows a "Create Quote" button for the still-claimed row, and clicking it calls `cs_intake_convert` which creates a second quote record in `work_items`. This results in the agent having two quote records for the same intake.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN an agent claims a RingCentral intake via `claim_ringcentral_intake`, THEN the system updates `customer_intakes` (status='claimed', assigned_to, converted_quote_id) but does NOT update the corresponding `cs_intake_submissions` row's `converted_at` or `work_item_id` fields

1.2 WHEN the IntakeQueue refreshes after a successful RingCentral claim, THEN the system still shows the intake row with status='claimed' and no `converted_at` value in `cs_intake_submissions`, causing the "Create Quote" button to appear

1.3 WHEN the agent clicks "Create Quote" on an intake that already has an `operational_quotes` record from the RC claim, THEN the system calls `cs_intake_convert` which creates a second quote record (a `work_items` entry) for the same intake

1.4 WHEN `isRingcentralSource(row)` evaluates a claimed RC intake, THEN the function returns `false` because `row.work_item_id` is null (it only becomes truthy after `cs_intake_convert` runs, not after `claim_ringcentral_intake`)

### Expected Behavior (Correct)

2.1 WHEN an agent claims a RingCentral intake via `claim_ringcentral_intake`, THEN the system SHALL also update the `cs_intake_submissions` row to set `status='converted'`, `converted_at=now()`, and `work_item_id` to the new quote ID so the UI reflects the conversion

2.2 WHEN the IntakeQueue refreshes after a successful RingCentral claim, THEN the system SHALL NOT display a "Create Quote" button for that intake because `converted_at` is already set

2.3 WHEN `cs_intake_convert` is called for an intake that already has a linked `operational_quotes` record, THEN the system SHALL return the existing quote ID without creating a duplicate (idempotency guard)

2.4 WHEN `isRingcentralSource(row)` evaluates an intake, THEN the function SHALL correctly identify RingCentral-sourced intakes regardless of whether `work_item_id` has been set, using source metadata or the `customer_intakes.source_type` field

### Unchanged Behavior (Regression Prevention)

3.1 WHEN an agent claims a non-RingCentral intake via `cs_intake_claim`, THEN the system SHALL CONTINUE TO set status='claimed' without auto-converting to a quote (the two-step claim-then-convert flow remains for non-RC intakes)

3.2 WHEN a manager assigns an intake via `assign_customer_intake`, THEN the system SHALL CONTINUE TO create exactly one quote and update both `customer_intakes` and `cs_intake_submissions` tables consistently

3.3 WHEN two agents attempt to claim the same RingCentral intake concurrently, THEN the system SHALL CONTINUE TO permit only the first valid transaction to succeed and return an error to subsequent attempts

3.4 WHEN `claim_ringcentral_intake` validation fails (wrong agent, unavailable, already claimed), THEN the system SHALL CONTINUE TO roll back all changes and return an error with no partial state

3.5 WHEN the IntakeQueue displays non-RC claimed intakes, THEN the system SHALL CONTINUE TO show the "Create Quote" button for legitimate claimed-but-not-converted intakes

---

## Bug Condition

### Bug Condition Function

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type IntakeClaimAction
  OUTPUT: boolean
  
  // The bug triggers when a RingCentral intake is claimed via claim_ringcentral_intake
  // and the cs_intake_submissions table is not synchronized with the result
  RETURN X.source_type = 'ringcentral'
    AND X.action = 'claim_ringcentral_intake'
    AND cs_intake_submissions[X.intake_id].converted_at IS NULL
    AND operational_quotes WHERE customer_intake_id = X.intake_id EXISTS
END FUNCTION
```

### Property Specification — Fix Checking

```pascal
// Property: Fix Checking — No duplicate quote after RC claim
FOR ALL X WHERE isBugCondition(X) DO
  result ← claim_ringcentral_intake'(X.intake_id)
  cs_row ← cs_intake_submissions[X.intake_id]
  ASSERT cs_row.converted_at IS NOT NULL
  ASSERT cs_row.status = 'converted'
  ASSERT count(quotes WHERE intake_id = X.intake_id) = 1
END FOR
```

### Preservation Goal

```pascal
// Property: Preservation Checking — Non-RC intakes unaffected
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)
  // Non-RC claim flow, manager assignment, validation failures
  // all behave identically before and after the fix
END FOR
```

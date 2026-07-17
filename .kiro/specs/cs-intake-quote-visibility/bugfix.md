# Bugfix Requirements Document

## Introduction

When a Customer Service intake is converted into a Work Desk quote (via the RingCentral claim or manual conversion workflow), two visibility gaps exist:

1. **Sales agents** cannot see the original intake form details (customer info, drivers, vehicles, coverage, notes) within the converted quote — they only see basic activity events.
2. **Customer Service agents** have no way to track the converted quote's status, view its event log, or know when prices have been sent — making it impossible to answer follow-up customer calls without interrupting the sales agent.

Additionally, managers need the ability to soft-delete converted quotes/work items from the CS Intake Queue view when a conversion was erroneous or the intake is no longer needed.

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a CS intake is claimed and converted into a Work Desk quote THEN the sales agent's quote detail view only shows basic event log entries (e.g., "created_from_cs_intake") without rendering the full intake form data (insured info, drivers, vehicles, coverage details, CSR notes) in a readable format

1.2 WHEN a CS intake has been converted and a customer calls back to check status THEN the Customer Service agent has no way to see the current quote status (e.g., "Pricing Sent", "Pending Pricing", "Sold", "Not Sold") from within the CS Intake Queue

1.3 WHEN a CS intake has been converted into a quote THEN the Customer Service agent cannot view the quote's event/activity log to determine what actions have been taken (prices sent, customer contacted, activation pending)

1.4 WHEN a converted quote needs to be deleted due to an error or duplicate THEN managers have no delete option for the converted work item visible from the CS Intake Queue

### Expected Behavior (Correct)

2.1 WHEN a CS intake is claimed and converted into a Work Desk quote THEN the sales agent's quote detail view SHALL display the full intake form data (insured personal info, all drivers, all vehicles, coverage preferences, current policy info, and CSR notes) in a structured, readable format as part of the quote's activity/history

2.2 WHEN a CS intake has been converted THEN the Customer Service agent SHALL see the current quote status (Active, Pricing Sent, Pending Pricing, Sold, Not Sold, etc.) displayed inline on the converted intake row in the CS Intake Queue

2.3 WHEN a CS intake has been converted THEN the Customer Service agent SHALL be able to open a read-only event log viewer showing all work item events (quote created, pricing sent, customer contacted, sold, not sold) so they can answer customer follow-up calls without contacting the sales agent

2.4 WHEN a manager views a converted intake in the CS Intake Queue THEN the system SHALL provide a soft-delete option that marks the linked work item/quote as deleted with an audit reason, only available to users with the manager role

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a CS intake has NOT been converted (status is draft, submitted, claimed, returned, or rejected) THEN the system SHALL CONTINUE TO show the existing intake queue actions (View, Claim, Create Quote, Edit, History, Delete, Assign) without any new quote-status UI elements

3.2 WHEN a sales agent views their Work Desk quotes that were NOT created from a CS intake THEN the system SHALL CONTINUE TO display the existing activity/event log format without any intake-specific sections

3.3 WHEN a Customer Service agent views the CS Intake Queue THEN the system SHALL CONTINUE TO show the existing real-time queue updates (unclaimed count, claimed count, filtering, search) without degradation from the new status/event features

3.4 WHEN a non-manager user views a converted intake THEN the system SHALL CONTINUE TO hide administrative actions (delete) and only show view/status information appropriate to their role

3.5 WHEN the existing intake history timeline is accessed for non-converted intakes THEN the system SHALL CONTINUE TO display the existing cs_intake_events timeline without modification

---

### Bug Condition (Formal)

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type IntakeQueueInteraction
  OUTPUT: boolean
  
  // The bug condition is triggered when:
  // 1. A CS intake has been converted (has work_item_id and converted_at)
  //    AND
  // 2. The user needs visibility into the quote's current state or full intake details
  RETURN X.intake.status = 'converted' 
     AND X.intake.work_item_id IS NOT NULL
     AND (X.user_needs_quote_status OR X.user_needs_intake_details_in_quote OR X.user_needs_event_log)
END FUNCTION
```

### Fix Checking Property

```pascal
// Property: Fix Checking - Intake Details Visible in Converted Quote
FOR ALL X WHERE isBugCondition(X) AND X.user_role IN ('agent', 'manager') DO
  quoteView <- renderQuoteDetail(X.intake.work_item_id)
  ASSERT quoteView.contains(intakeFormData(X.intake))
END FOR

// Property: Fix Checking - CS Agent Sees Quote Status
FOR ALL X WHERE isBugCondition(X) AND X.user_role IN ('customer_service', 'manager') DO
  queueRow <- renderIntakeQueueRow(X.intake)
  ASSERT queueRow.displays(currentQuoteStatus(X.intake.work_item_id))
END FOR

// Property: Fix Checking - CS Agent Can View Quote Event Log
FOR ALL X WHERE isBugCondition(X) AND X.user_role IN ('customer_service', 'manager') DO
  eventLog <- openQuoteEventLog(X.intake.work_item_id)
  ASSERT eventLog.contains(allWorkItemEvents(X.intake.work_item_id))
END FOR

// Property: Fix Checking - Manager Delete Option Available
FOR ALL X WHERE isBugCondition(X) AND X.user_role = 'manager' DO
  actions <- renderConvertedIntakeActions(X.intake)
  ASSERT actions.contains('soft_delete_quote')
END FOR
```

### Preservation Checking Property

```pascal
// Property: Preservation Checking - Non-converted intakes unchanged
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT renderIntakeQueue(X) = renderIntakeQueue_original(X)
END FOR
```

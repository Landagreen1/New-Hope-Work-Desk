# Requirements Document

## Introduction

The Time & Attendance module of New Hope Work Desk is redesigned so that daily attendance management becomes simpler, connected, and exception-driven. Four areas are rebuilt: Time Clock (becomes **Today**), Time Off and Coverage (merged into **Time Off & Coverage**), and Reports (becomes **Review**). Three areas are preserved: **Schedule**, **Payroll**, and **Workforce**.

The redesign introduces one authoritative daily attendance calculation per employee per work date, replacing the several independent and mutually inconsistent calculations that exist today across `TimeClock.tsx`, `/api/time-clock/reports`, `/api/payroll/calculate`, and `/api/staffing`. It also introduces forward-looking coverage projection, which does not exist today, so that leave decisions can be made against projected staffing rather than against the current clocked-in headcount.

Appendix A records the current-system audit, including the calculation rules that exist today and must be preserved or explicitly changed. Appendix B records open questions that require a decision from the product owner before implementation begins.

Scope boundary: this document defines behaviour and data requirements. Component structure, database object design, and migration content are defined in the design document.

## Glossary

- **Time_Attendance_Module**: The Time & Attendance area of New Hope Work Desk, reached through the `time_attendance` sidebar module.
- **Navigation_Service**: The sidebar and workspace routing logic in `src/components/app-sidebar.tsx` and `src/components/role-workspace.tsx` that resolves a module and sub-navigation identifier to a rendered screen.
- **Attendance_Service**: The single authoritative server-side calculation that produces one Daily_Attendance_Record per employee per work date.
- **Daily_Attendance_Record**: The computed record for one employee on one calendar work date, combining schedule, clock entries, break entries, approved time off, manager corrections, and department coverage requirements.
- **Derived_Status**: The single attendance status assigned to a Daily_Attendance_Record, selected from the Status Rule Matrix in Requirement 3.
- **Attendance_Exception**: A condition on a Daily_Attendance_Record that requires human review, as defined in Requirement 12.
- **Coverage_Service**: The single authoritative server-side calculation that produces staffing counts for a department and date, in both Live_Coverage and Projected_Coverage forms.
- **Live_Coverage**: Coverage for the current date and time, derived from actual clock state.
- **Projected_Coverage**: Coverage for a current or future date, derived from published schedules minus approved absences minus any proposed absence.
- **Coverage_Interval**: A contiguous time span within one date over which the set of scheduled employees does not change.
- **Coverage_Status**: One of Healthy, At_Minimum, Warning, or Critical, assigned to a date or a Coverage_Interval.
- **PTO_Service**: The server-side service that records time-off requests, decisions, and balance changes.
- **Payroll_Service**: The existing payroll calculation and processing logic in `/api/payroll/calculate` and `/api/payroll/process`.
- **Today_Screen**: The first Time & Attendance navigation item, replacing the Time Clock screen.
- **My_Day_View**: The employee-facing content of the Today_Screen.
- **Team_Today_View**: The administrator-facing content of the Today_Screen.
- **Live_Coverage_Panel**: The department coverage section of the Today_Screen.
- **Time_Off_Coverage_Screen**: The third navigation item, merging time-off requests and coverage.
- **Request_Inbox**: The list of time-off requests on the Time_Off_Coverage_Screen.
- **Coverage_Calendar**: The date-grid view of Projected_Coverage on the Time_Off_Coverage_Screen.
- **Request_Decision_Drawer**: The side drawer that presents one time-off request and its decision controls.
- **Approval_Impact_Preview**: The Projected_Coverage calculation shown before a time-off decision is committed.
- **Review_Center**: The fourth navigation item, replacing the Reports screen.
- **Exception_Queue**: The default view of the Review_Center, listing Daily_Attendance_Records that carry an Attendance_Exception.
- **Overview_View**: The aggregate metrics view inside the Review_Center.
- **Employee_Trends_View**: The single-employee history view inside the Review_Center.
- **Export_Service**: The server-side service that produces CSV files from the active filter set.
- **Attendance_Audit_Log**: The append-only record of attendance corrections, time-off decisions, coverage overrides, and payroll processing events.
- **Needs_Attention_Inbox**: The compact control that aggregates unresolved items across the Time_Attendance_Module.
- **Health_Ribbon**: The seven-day workforce health strip shown on the Today_Screen, Schedule_Screen, and Time_Off_Coverage_Screen.
- **Schedule_Screen**: The preserved shift-scheduling screen, currently `ScheduleManager.tsx`.
- **Payroll_Screen**: The preserved payroll screens, currently `PayrollDashboard.tsx` and `PayrollProcessor.tsx`.
- **Workforce_Screen**: The preserved workforce configuration screen, currently `WorkforceAdmin.tsx`.
- **Attendance_Administrator**: A signed-in user whose role satisfies `canAdministerAttendance` in `src/lib/permissions.ts`. Today this resolves to `super_admin` only. See Appendix B, Open Question 1.
- **Employee**: Any signed-in user acting on that user's own attendance data.
- **Grace_Period**: The number of minutes after a scheduled shift start within which a clock-in is not treated as late. The current value is 5 minutes.
- **Payroll_Blocking**: The property of an Attendance_Exception that prevents a Daily_Attendance_Record from producing trustworthy paid hours, as defined in Requirement 12.

## Requirements

### Requirement 1: Time & Attendance Navigation Restructure

**User Story:** As a Time & Attendance user, I want six clearly named navigation items, so that I can reach the screen matching the task at hand without scanning seven overlapping tabs.

#### Acceptance Criteria

1. THE Navigation_Service SHALL present the Time & Attendance sub-navigation in the order Today, Schedule, Time Off & Coverage, Review, Payroll, Workforce.
2. THE Navigation_Service SHALL present Today, Schedule, and Time Off & Coverage to every signed-in user.
3. WHERE the signed-in user is an Attendance_Administrator, THE Navigation_Service SHALL additionally present Review, Payroll, and Workforce.
4. WHERE the signed-in user is not an Attendance_Administrator, THE Navigation_Service SHALL omit Review, Payroll, and Workforce from the Time & Attendance sub-navigation.
5. THE Navigation_Service SHALL omit a standalone Coverage navigation item.
6. THE Navigation_Service SHALL omit a standalone Reports navigation item.
7. WHEN a user selects Today, THE Navigation_Service SHALL render the Today_Screen.
8. WHEN a user selects Time Off & Coverage, THE Navigation_Service SHALL render the Time_Off_Coverage_Screen.
9. WHEN a user selects Review, THE Navigation_Service SHALL render the Review_Center with the Exception_Queue active.
10. IF a stored navigation state references a removed sub-navigation identifier, THEN THE Navigation_Service SHALL resolve that state to the Today_Screen without raising an error.
11. THE Navigation_Service SHALL accept a target that names a screen, a record identifier, and a detail-drawer instruction, so that the Needs_Attention_Inbox can open a specific record.
12. WHEN the Navigation_Service receives a target naming a record that the signed-in user is not permitted to read, THE Navigation_Service SHALL render the target screen without the detail drawer and SHALL display the reason the record is unavailable.

### Requirement 2: Preservation of Schedule, Payroll, and Workforce

**User Story:** As the product owner, I want Schedule, Payroll, and Workforce to keep working exactly as they do today, so that the redesign carries no risk to shift assignment or pay.

#### Acceptance Criteria

1. THE Schedule_Screen SHALL retain the week grid, week navigation, add-shift action, delete-shift action, and template application behaviour that exist before the redesign.
2. THE Payroll_Screen SHALL retain the period selection, calculation, review, processing, period-locking, payroll history, and CSV export behaviour that exist before the redesign.
3. THE Workforce_Screen SHALL retain the pay-rate editing, PTO-balance editing, and clock-entry editing behaviour that exist before the redesign.
4. THE Payroll_Service SHALL produce the same regular hours, overtime hours, break hours, total hours, PTO days, gross pay, deductions total, and net pay for a given period and data set as the pre-redesign implementation produces for that same period and data set.
5. WHERE a change to the Schedule_Screen, Payroll_Screen, or Workforce_Screen is required for the connected experience, THE Time_Attendance_Module SHALL limit that change to navigation placement, filter controls, status vocabulary, visual styling, or reading from the Attendance_Service.
6. IF a proposed change would alter a Payroll_Service output value for an unchanged input data set, THEN THE Time_Attendance_Module SHALL record that change as an explicit, separately approved payroll rule change before the change is applied.
7. THE Time_Attendance_Module SHALL retain the existing `time_clock_entries`, `time_clock_breaks`, `employee_schedules`, `pto_requests`, `pto_balances`, `payroll_periods`, `payroll_summaries`, `employee_payment_settings`, and `staffing_thresholds` tables and SHALL apply schema changes through forward-only migrations.

### Requirement 3: Unified Daily Attendance Record

**User Story:** As an Attendance_Administrator, I want one authoritative attendance calculation, so that Today, Time Off & Coverage, Review, and Payroll all report the same status and the same hours for the same employee and date.

#### Acceptance Criteria

1. THE Attendance_Service SHALL produce at most one Daily_Attendance_Record per employee per calendar work date.
2. THE Attendance_Service SHALL derive each Daily_Attendance_Record from published schedules, clock entries, break entries, approved time-off requests, recorded corrections, and department coverage requirements.
3. THE Attendance_Service SHALL expose scheduled start, scheduled end, scheduled hours, first clock-in, last clock-out, worked hours, paid break minutes, unpaid break minutes, late minutes, early-departure minutes, Derived_Status, and the list of Attendance_Exception values for each Daily_Attendance_Record.
4. THE Attendance_Service SHALL assign exactly one Derived_Status per Daily_Attendance_Record from the set Scheduled, Working, On_Break, Completed, Late, Absent, Approved_Time_Off, Clocked_In_Unscheduled, Left_Early, Missing_Clock_In, Missing_Clock_Out, Needs_Review.
5. THE Attendance_Service SHALL assign Derived_Status according to the Status Rule Matrix below, evaluating rules in the stated precedence order and assigning the first matching status.
6. THE Attendance_Service SHALL determine the calendar work date of a clock entry using the employee timezone recorded in `profiles.timezone`.
7. THE Attendance_Service SHALL interpret `employee_schedules.shift_start` and `employee_schedules.shift_end` in the business timezone `America/New_York`, including daylight-saving transitions.
8. THE Attendance_Service SHALL compute worked hours for a Daily_Attendance_Record as the sum of completed clock sessions on that date, where each session equals the clock-out instant minus the clock-in instant minus that session's unpaid break minutes.
9. WHILE a clock session on a Daily_Attendance_Record has no clock-out, THE Attendance_Service SHALL report worked hours for that session as elapsed time from the clock-in instant to the evaluation instant minus that session's unpaid break minutes.
10. THE Attendance_Service SHALL classify a break of type `lunch` as unpaid and a break of type `short` or `personal` as paid.
11. THE Attendance_Service SHALL compute scheduled hours for a Daily_Attendance_Record once per date, independent of the number of clock sessions recorded on that date.
12. THE Attendance_Service SHALL compute late minutes as the first clock-in instant minus the scheduled start instant, and SHALL report a late condition only when that difference exceeds the Grace_Period.
13. THE Attendance_Service SHALL expose, for each Attendance_Exception on a Daily_Attendance_Record, the identifier of the rule that produced that exception and a plain-language description of that rule.
14. THE Time_Attendance_Module SHALL read Derived_Status, worked hours, scheduled hours, late minutes, and break minutes only from the Attendance_Service.
15. THE Time_Attendance_Module SHALL contain no client-side derivation of Derived_Status, late status, absence status, worked hours, or scheduled hours.
16. WHEN a correction is recorded against a clock entry, break entry, schedule, or time-off request, THE Attendance_Service SHALL recompute the affected Daily_Attendance_Record before the next read returns.
17. WHERE an employee records more than one clock session on one date, THE Attendance_Service SHALL include every session in worked hours and SHALL evaluate the late condition against the earliest session only.
18. WHERE a scheduled shift ends on the calendar date following the scheduled start date, THE Attendance_Service SHALL attribute the whole shift and every clock session belonging to that shift to the scheduled start date.

#### Status Rule Matrix

Rules are evaluated in this order. The first rule whose condition holds assigns the Derived_Status.

| Order | Derived_Status | Condition |
| --- | --- | --- |
| 1 | Approved_Time_Off | An approved time-off request covers the date, and no clock session exists on the date. |
| 2 | Missing_Clock_Out | A clock session on the date has a clock-in and no clock-out, and the scheduled end instant plus a configured tolerance has passed. |
| 3 | On_Break | A clock session on the date is open and an unended break exists on that session. |
| 4 | Working | A clock session on the date is open and no unended break exists on that session. |
| 5 | Clocked_In_Unscheduled | At least one clock session exists on the date and no published schedule exists for the employee on that date. |
| 6 | Missing_Clock_In | A published schedule exists for the date, no clock session exists on the date, no approved time off covers the date, and the scheduled end instant has not passed. |
| 7 | Absent | A published schedule exists for the date, no clock session exists on the date, no approved time off covers the date, and the scheduled end instant has passed. |
| 8 | Left_Early | Every clock session on the date is closed, and the last clock-out instant precedes the scheduled end instant by more than the configured early-departure tolerance. |
| 9 | Late | Every clock session on the date is closed, and the first clock-in instant exceeds the scheduled start instant by more than the Grace_Period. |
| 10 | Completed | Every clock session on the date is closed, the first clock-in is within the Grace_Period, and the last clock-out is within the early-departure tolerance. |
| 11 | Scheduled | A published schedule exists for a future date. |
| 12 | Needs_Review | The date matches no rule above, or the recorded data is internally inconsistent. |

### Requirement 4: Today — My Day (Employee)

**User Story:** As an Employee, I want a focused view of my current shift with one obvious action, so that I can clock accurately without deciding between several buttons.

#### Acceptance Criteria

1. THE My_Day_View SHALL display today's scheduled shift start, scheduled shift end, and scheduled hours for the signed-in Employee.
2. THE My_Day_View SHALL display the signed-in Employee's Derived_Status for today.
3. THE My_Day_View SHALL display the first clock-in time of today when a clock session exists for today.
4. THE My_Day_View SHALL display worked hours accumulated today, refreshed at an interval of 60 seconds or shorter while a clock session is open.
5. THE My_Day_View SHALL display total break minutes recorded today and SHALL distinguish paid break minutes from unpaid break minutes.
6. THE My_Day_View SHALL display the expected clock-out time for today derived from the scheduled shift end.
7. THE My_Day_View SHALL display one primary action at a time.
8. WHILE the signed-in Employee has no open clock session today, THE My_Day_View SHALL present Clock In as the primary action.
9. WHILE the signed-in Employee has an open clock session and no unended break, THE My_Day_View SHALL present Start Break as the primary action and SHALL present Clock Out as a secondary action.
10. WHILE the signed-in Employee has an unended break, THE My_Day_View SHALL present End Break as the primary action.
11. THE My_Day_View SHALL present at most one action styled as the primary action at any time.
12. WHEN the Attendance_Service reports Derived_Status Clocked_In_Unscheduled for the signed-in Employee today, THE My_Day_View SHALL display an alert stating that the Employee is not scheduled today.
13. WHEN the Attendance_Service reports a late condition for the signed-in Employee today, THE My_Day_View SHALL display an alert stating the number of minutes late.
14. WHILE the signed-in Employee has an unended break, THE My_Day_View SHALL display an alert stating that a break is still active and the elapsed break duration.
15. WHEN the scheduled shift end instant has passed and the signed-in Employee has an open clock session, THE My_Day_View SHALL display an alert stating that the scheduled shift has ended.
16. WHEN the Attendance_Service reports Derived_Status Missing_Clock_Out for the signed-in Employee on any of the seven dates preceding today, THE My_Day_View SHALL display an alert naming that date.
17. WHEN a clock session begins more than 60 minutes before the scheduled start instant or ends more than 60 minutes after the scheduled end instant, THE My_Day_View SHALL display an alert stating that the Employee is working outside the scheduled shift.
18. THE My_Day_View SHALL present the signed-in Employee's recent attendance history for at least the preceding 14 dates in a section subordinate to today's shift.
19. THE My_Day_View SHALL display, for each date in the recent attendance history, the date, Derived_Status, scheduled hours, worked hours, and any Attendance_Exception.
20. IF a clock action fails, THEN THE My_Day_View SHALL display the failure reason and SHALL leave the displayed clock state unchanged.
21. IF the signed-in Employee submits a clock action while an identical action is already in flight, THEN THE My_Day_View SHALL record at most one clock event.

### Requirement 5: Today — Team Today (Administrator)

**User Story:** As an Attendance_Administrator, I want an operational attendance command centre for today, so that I can see who is working, who is missing, and what needs action.

#### Acceptance Criteria

1. THE Team_Today_View SHALL display the signed-in Attendance_Administrator's own clock status and primary clock action as a compact header control.
2. THE Team_Today_View SHALL allocate the primary content area to team attendance rather than to the signed-in user's own clock.
3. THE Team_Today_View SHALL display summary counters for scheduled today, working, late, on break, approved time off, not clocked in, missing punches, and coverage warnings.
4. THE Team_Today_View SHALL derive every summary counter from the Attendance_Service.
5. WHEN a user selects a summary counter, THE Team_Today_View SHALL filter the employee table to the records that produced that counter.
6. WHILE a summary counter filter is active, THE Team_Today_View SHALL display the active filter and SHALL present a control that clears the filter.
7. THE Team_Today_View SHALL display a table with one row per employee scheduled today or clocked in today.
8. THE Team_Today_View SHALL display, in each employee row, employee name, department, scheduled start, scheduled end, first clock-in, clock-out or open-session indicator, Derived_Status, worked hours, break minutes, and any Attendance_Exception.
9. THE Team_Today_View SHALL present filters for department, Derived_Status, and Attendance_Exception type.
10. WHEN a user selects an employee row, THE Team_Today_View SHALL open a right-side drawer for that employee.
11. THE employee drawer SHALL display today's scheduled shift, an ordered attendance timeline for today, the raw clock events for today, the break events for today, the Derived_Status, and the Attendance_Exception list with the rule that produced each exception.
12. THE employee drawer SHALL display the manager notes recorded against the selected employee and date.
13. THE employee drawer SHALL display the selected employee's attendance history for at least the preceding 14 dates.
14. THE employee drawer SHALL display the Attendance_Audit_Log entries for the selected employee and date.
15. WHERE the signed-in user is an Attendance_Administrator, THE employee drawer SHALL present the actions Correct Punch, Add Missing Punch, Approve Unscheduled Work, Add Manager Note, and Mark Reviewed.
16. WHEN an Attendance_Administrator submits Correct Punch or Add Missing Punch, THE Attendance_Service SHALL require a reason of at least one non-whitespace character.
17. WHEN a correction is committed, THE Attendance_Audit_Log SHALL record the employee, work date, field changed, previous value, new value, actor, reason, and timestamp.
18. WHEN a correction is committed, THE Team_Today_View SHALL display the recomputed Derived_Status and worked hours without requiring a page reload.
19. THE Team_Today_View SHALL refresh displayed attendance state at an interval of 60 seconds or shorter.
20. IF the Team_Today_View cannot load team attendance data, THEN THE Team_Today_View SHALL display the failure reason and SHALL present a retry control.
21. WHERE the signed-in user is not an Attendance_Administrator, THE Today_Screen SHALL render the My_Day_View and SHALL omit the Team_Today_View.

### Requirement 6: Today — Live Coverage

**User Story:** As an Attendance_Administrator, I want live department coverage on the Today screen, so that I can see current staffing gaps while they are still actionable.

#### Acceptance Criteria

1. THE Live_Coverage_Panel SHALL display one compact row per department.
2. THE Live_Coverage_Panel SHALL display, per department, required staffing, scheduled staffing, currently working headcount, on-break headcount, approved-off headcount, missing headcount, and Coverage_Status.
3. THE Coverage_Service SHALL compute required staffing from `staffing_thresholds` for the current day of week and current time slot.
4. IF no `staffing_thresholds` row exists for a department, day of week, and time slot, THEN THE Live_Coverage_Panel SHALL display the required staffing as unconfigured and SHALL assign Coverage_Status Healthy.
5. THE Coverage_Service SHALL compute currently working headcount as the count of employees whose Derived_Status is Working for the current date.
6. THE Coverage_Service SHALL compute on-break headcount as the count of employees whose Derived_Status is On_Break for the current date.
7. THE Coverage_Service SHALL exclude on-break employees from the currently working headcount.
8. THE Coverage_Service SHALL compute missing headcount as the count of employees scheduled on the date whose Derived_Status is none of Working, On_Break, and Approved_Time_Off.
9. THE Coverage_Service SHALL assign Coverage_Status Critical when available staffing is below `staffing_thresholds.minimum_staff`.
10. THE Coverage_Service SHALL assign Coverage_Status At_Minimum when available staffing equals `staffing_thresholds.minimum_staff`.
11. THE Coverage_Service SHALL assign Coverage_Status Warning when available staffing exceeds `staffing_thresholds.minimum_staff` and is less than or equal to `staffing_thresholds.warning_threshold`.
12. THE Coverage_Service SHALL assign Coverage_Status Healthy when available staffing exceeds `staffing_thresholds.warning_threshold`.
13. THE Coverage_Service SHALL compute available staffing for a department and instant as the count of employees whose Derived_Status is Working for that department at that instant.
14. WHEN a user selects a department row, THE Live_Coverage_Panel SHALL open a drawer listing the employees counted in each headcount for that department.
15. THE Live_Coverage_Panel SHALL label the displayed content as current operational coverage and SHALL distinguish that content from the Projected_Coverage used for leave decisions.
16. THE Live_Coverage_Panel SHALL refresh displayed coverage at an interval of 60 seconds or shorter.

### Requirement 7: Time Off & Coverage — Merged Screen and Request Inbox

**User Story:** As an Attendance_Administrator, I want time-off requests and coverage on one screen, so that I can decide a request while seeing the staffing effect.

#### Acceptance Criteria

1. WHERE the viewport width is 1280 pixels or greater, THE Time_Off_Coverage_Screen SHALL present the Request_Inbox on the left, the Coverage_Calendar in the centre, and the Request_Decision_Drawer on the right.
2. WHERE the viewport width is below 1280 pixels, THE Time_Off_Coverage_Screen SHALL stack the Request_Inbox, the Coverage_Calendar, and the Request_Decision_Drawer in that order.
3. WHERE the viewport width is below 768 pixels, THE Time_Off_Coverage_Screen SHALL present the Request_Decision_Drawer as a full-width overlay.
4. THE Request_Inbox SHALL display one compact row per time-off request.
5. THE Request_Inbox SHALL display, in each row, employee name, department, request type, requested start date, requested end date, number of working days requested, current status, remaining balance for the requested type, coverage risk indicator, submission date, and elapsed time awaiting review.
6. THE Request_Inbox SHALL present filters for status, department, employee, request type, date range, and coverage risk.
7. THE Request_Inbox SHALL support the status filter values pending, approved, denied, and cancelled.
8. THE Request_Inbox SHALL order pending requests before decided requests by default.
9. THE Request_Inbox SHALL derive the coverage risk indicator for a request from the Projected_Coverage produced by the Coverage_Service for the requested dates.
10. WHEN a user selects a request row, THE Time_Off_Coverage_Screen SHALL open the Request_Decision_Drawer for that request and SHALL highlight the requested dates in the Coverage_Calendar.
11. WHERE the signed-in user is not an Attendance_Administrator, THE Request_Inbox SHALL display only the signed-in Employee's own requests.
12. THE Request_Inbox SHALL load requests in pages of at most 50 rows.

### Requirement 8: Coverage Calendar with Projected Coverage

**User Story:** As an Attendance_Administrator, I want a calendar that shows projected staffing per date, so that I can see which dates cannot absorb another absence.

#### Acceptance Criteria

1. THE Coverage_Calendar SHALL present a monthly view and a two-week view, and SHALL let the user switch between the two.
2. THE Coverage_Calendar SHALL display, for each date, the scheduled employee count, the approved absence count, the pending request count, the minimum required coverage, the Projected_Coverage, and the Coverage_Status.
3. THE Coverage_Calendar SHALL display at most one Coverage_Status indicator and at most four numeric values inside a date cell.
4. THE Coverage_Calendar SHALL convey Coverage_Status using a text label or an icon in addition to colour.
5. WHEN a user selects a date, THE Coverage_Calendar SHALL open a drawer listing the scheduled employees, the approved absences, the pending requests, and the Coverage_Interval breakdown for that date.
6. THE Coverage_Service SHALL compute Projected_Coverage for a date as the count of employees with a published schedule on that date minus the count of employees with an approved absence covering that date.
7. THE Coverage_Service SHALL exclude the current clocked-in headcount from Projected_Coverage for future dates.
8. THE Coverage_Service SHALL compute Projected_Coverage for a date and department using the same expression used for the whole organisation, restricted to employees mapped to that department.
9. THE Coverage_Service SHALL compute a Coverage_Interval set for a date by partitioning the date at every distinct scheduled start instant and scheduled end instant present on that date.
10. THE Coverage_Service SHALL compute available staffing and required staffing for each Coverage_Interval.
11. THE Coverage_Service SHALL assign a Coverage_Status to each Coverage_Interval using the same thresholds defined in Requirement 6.
12. THE Coverage_Calendar SHALL retrieve coverage for the whole displayed date range in a single request.
13. WHERE the signed-in user is not an Attendance_Administrator, THE Coverage_Calendar SHALL display approved absences without employee names unless a shared absence calendar permission grants name visibility.

### Requirement 9: Approval Impact Preview

**User Story:** As an Attendance_Administrator, I want to see the staffing effect of an approval before I commit it, so that I do not create a shortage by accident.

#### Acceptance Criteria

1. WHEN the Request_Decision_Drawer opens for a pending request, THE Approval_Impact_Preview SHALL compute Projected_Coverage for every date in the requested range with the requested absence included as a proposed absence.
2. THE Approval_Impact_Preview SHALL compute Projected_Coverage for each requested date as scheduled employees minus approved absences minus the proposed absence.
3. THE Approval_Impact_Preview SHALL display, for each requested date, the projected available staffing, the required staffing, and the resulting Coverage_Status.
4. WHERE the schedule data for a requested date defines more than one distinct scheduled start instant or scheduled end instant, THE Approval_Impact_Preview SHALL display available staffing and required staffing for each Coverage_Interval on that date.
5. THE Approval_Impact_Preview SHALL display each Coverage_Interval as a start time, an end time, an available count, and a required count.
6. THE Approval_Impact_Preview SHALL compute Coverage_Interval availability for the requested dates from published schedules and approved absences, not from clock entries.
7. THE Request_Decision_Drawer SHALL display the requesting employee, department, request type, requested dates, number of working days requested, and stated reason.
8. THE Request_Decision_Drawer SHALL display the requesting employee's balance for the requested type before the decision and the balance that would result after approval.
9. THE Request_Decision_Drawer SHALL display the number of calendar days of notice between the submission date and the requested start date.
10. THE Request_Decision_Drawer SHALL display the requesting employee's other approved absences that fall within 14 days of the requested range.
11. THE Request_Decision_Drawer SHALL display other pending requests from any employee whose dates overlap the requested range.
12. THE Request_Decision_Drawer SHALL display the employees who are scheduled on the requested dates and who hold no approved absence on those dates, as available backup employees.
13. THE Request_Decision_Drawer SHALL display the manager notes and the Attendance_Audit_Log entries recorded against the request.
14. IF the Coverage_Service cannot compute Projected_Coverage for a requested date, THEN THE Approval_Impact_Preview SHALL display that the projection is unavailable for that date and SHALL state the reason.

### Requirement 10: Leave Decision Options and Below-Minimum Guard

**User Story:** As an Attendance_Administrator, I want more decision options than approve and deny, so that I can protect coverage without rejecting reasonable requests.

#### Acceptance Criteria

1. THE Request_Decision_Drawer SHALL present the decision options approve full request, deny request, approve part of the request, suggest different dates, find or assign coverage, approve after assigning coverage, add to waitlist, and request additional information.
2. WHEN an Attendance_Administrator approves a full request, THE PTO_Service SHALL set the request status to approved and SHALL record the reviewer and the decision timestamp.
3. WHEN an Attendance_Administrator denies a request, THE PTO_Service SHALL require a denial reason of at least one non-whitespace character and SHALL store that reason.
4. WHEN an Attendance_Administrator approves part of a request, THE PTO_Service SHALL record the approved date range, SHALL record the declined date range, and SHALL debit the balance only for the approved working days.
5. WHEN an Attendance_Administrator suggests different dates, THE PTO_Service SHALL set the request status to information requested, SHALL store the suggested date range, and SHALL leave the balance unchanged.
6. WHEN an Attendance_Administrator adds a request to the waitlist, THE PTO_Service SHALL set the request status to waitlisted and SHALL leave the balance unchanged.
7. WHEN an Attendance_Administrator requests additional information, THE PTO_Service SHALL set the request status to information requested, SHALL store the question, and SHALL leave the balance unchanged.
8. WHEN an Attendance_Administrator assigns coverage for a requested date, THE PTO_Service SHALL create or amend a published schedule entry for the covering employee on that date and SHALL link that entry to the request.
9. IF an approval would set Projected_Coverage below required staffing for any date or Coverage_Interval in the approved range, THEN THE Request_Decision_Drawer SHALL block the approval until coverage is assigned for the shortfall, the Attendance_Administrator acknowledges the shortfall, or the Attendance_Administrator supplies an override reason.
10. WHEN an Attendance_Administrator supplies an override reason, THE PTO_Service SHALL require a reason of at least one non-whitespace character and SHALL store that reason with the decision.
11. WHEN any leave decision is committed, THE Attendance_Audit_Log SHALL record the request identifier, employee, decision, previous status, new status, actor, reason, affected dates, and timestamp.
12. WHEN a leave decision is committed, THE Coverage_Service SHALL recompute Projected_Coverage for every affected date before the next read returns.
13. WHEN a request status changes to approved, THE PTO_Service SHALL debit the requesting employee's balance for the requested type by the number of approved working days.
14. WHEN a previously approved request changes to denied or cancelled, THE PTO_Service SHALL credit the requesting employee's balance for the requested type by the number of working days previously debited.
15. THE PTO_Service SHALL attribute a balance debit or credit to the calendar year containing each affected date.
16. WHERE an approved request spans two calendar years, THE PTO_Service SHALL debit each year's balance by the number of approved working days falling in that year.
17. IF an Attendance_Administrator submits the same decision for the same request more than once, THEN THE PTO_Service SHALL apply the balance change once.
18. IF a balance change cannot be recorded, THEN THE PTO_Service SHALL leave the request status unchanged and SHALL return the failure reason.
19. THE PTO_Service SHALL reject a decision submitted by the employee who owns the request.
20. THE PTO_Service SHALL accept the request types defined by the `pto_requests.pto_type` constraint, and THE Time_Off_Coverage_Screen SHALL offer only request types that the constraint accepts.

### Requirement 11: Employee Time-Off Self-Service

**User Story:** As an Employee, I want to manage my own time off, so that I can request leave and track its outcome without contacting an administrator.

#### Acceptance Criteria

1. THE Time_Off_Coverage_Screen SHALL let an Employee submit a time-off request specifying request type, start date, end date, and reason.
2. THE PTO_Service SHALL compute the number of working days for a submitted request on the server and SHALL store that computed value.
3. THE Time_Off_Coverage_Screen SHALL display the signed-in Employee's remaining balance for each request type before submission.
4. IF a submitted request exceeds the signed-in Employee's remaining balance for the requested type, THEN THE Time_Off_Coverage_Screen SHALL display the shortfall and SHALL allow submission with the shortfall disclosed.
5. IF a submitted request starts fewer than 14 calendar days after the submission date, THEN THE Time_Off_Coverage_Screen SHALL display the short-notice condition and SHALL record that condition on the request.
6. THE Time_Off_Coverage_Screen SHALL display the signed-in Employee's pending requests, approved requests, denied requests, waitlisted requests, and cancelled requests.
7. THE Time_Off_Coverage_Screen SHALL display the reviewer response text for each decided request belonging to the signed-in Employee.
8. WHERE a request belonging to the signed-in Employee has status pending or waitlisted, THE Time_Off_Coverage_Screen SHALL present a cancel action for that request.
9. WHEN an Employee cancels an eligible request, THE PTO_Service SHALL set the request status to cancelled and SHALL record the actor and timestamp.
10. THE PTO_Service SHALL reject an Employee's attempt to change a request that has status approved or denied.
11. WHERE the shared absence calendar permission grants visibility, THE Time_Off_Coverage_Screen SHALL display approved absences of other employees to the signed-in Employee.

### Requirement 12: Review — Exception Queue

**User Story:** As an Attendance_Administrator, I want the Review screen to open on records that need action, so that my first screen is a work queue rather than a chart.

#### Acceptance Criteria

1. THE Review_Center SHALL present the views Exceptions, Overview, Employee Trends, Exports, and Audit Log in that order.
2. THE Review_Center SHALL activate the Exceptions view by default.
3. THE Exception_Queue SHALL present the saved filters needs attention, payroll blocking, missing punches, missing clock-ins, missing clock-outs, late arrivals, early departures, absences, break issues, unscheduled work, pending manager approval, corrected, and all records.
4. THE Exception_Queue SHALL display one row per employee per work date.
5. THE Exception_Queue SHALL display, in each row, employee name, department, work date, Attendance_Exception type, scheduled time span, actual time span, worked hours, payroll impact, review status, and one primary action.
6. THE Exception_Queue SHALL present at most one action styled as the primary action in each row.
7. THE Exception_Queue SHALL select the primary action for a row from Correct Punch, Add Clock-Out, Review Lateness, Approve Unscheduled Work, Add Manager Note, and Mark Reviewed, according to the Attendance_Exception type of that row.
8. THE Attendance_Service SHALL mark an Attendance_Exception as Payroll_Blocking when the exception is Missing_Clock_Out, when the exception is Missing_Clock_In on a date carrying a published schedule, or when the exception is unapproved unscheduled work.
9. THE Exception_Queue SHALL display the Payroll_Blocking property of each row using a text label or an icon in addition to colour.
10. WHEN a user selects an Exception_Queue row, THE Review_Center SHALL open a side drawer for that employee and work date.
11. THE exception drawer SHALL display the published schedule, the raw clock events, the break timeline, the calculated scheduled hours, the calculated worked hours, the rule that produced each Attendance_Exception, the payroll impact, the manager notes, the previous corrections, and the Attendance_Audit_Log entries for that employee and work date.
12. THE exception drawer SHALL present correction controls for clock-in instant, clock-out instant, break minutes, and manager note.
13. WHEN an Attendance_Administrator commits a correction from the exception drawer, THE Attendance_Service SHALL require a reason of at least one non-whitespace character.
14. WHEN a correction is committed, THE Exception_Queue SHALL display the recomputed Derived_Status, worked hours, and Attendance_Exception list for the affected row.
15. WHEN an Attendance_Administrator marks a row reviewed, THE Attendance_Service SHALL set the review status to reviewed and SHALL record the actor and timestamp in the Attendance_Audit_Log.
16. IF an Attendance_Administrator marks the same row reviewed more than once, THEN THE Attendance_Service SHALL retain the first review actor and timestamp.
17. THE Exception_Queue SHALL load rows in pages of at most 100 rows.
18. THE Exception_Queue SHALL render large result sets using pagination or list virtualisation.
19. THE Exception_Queue SHALL present a date-range control and SHALL default that control to the current pay period.
20. THE Exception_Queue SHALL display each row once even when that row carries more than one Attendance_Exception.

### Requirement 13: Review — Overview with Drill-Down

**User Story:** As an Attendance_Administrator, I want aggregate attendance metrics that open the underlying records, so that every number can be explained.

#### Acceptance Criteria

1. THE Overview_View SHALL present the date presets today, yesterday, this week, last week, current pay period, previous pay period, and custom range.
2. THE Overview_View SHALL present filters for employee, department, Derived_Status, Attendance_Exception type, review status, and Payroll_Blocking status.
3. THE Overview_View SHALL display attendance rate, scheduled hours, actual worked hours, approved payable hours, overtime hours, late arrival count, total late minutes, early departure count, absence count, time-off days, missing clock-in count, missing clock-out count, unscheduled work count, and break exception count.
4. THE Overview_View SHALL derive every displayed metric from the Attendance_Service.
5. WHEN a user selects a displayed metric, THE Overview_View SHALL open the Exception_Queue filtered to the Daily_Attendance_Record set that produced that metric.
6. THE Overview_View SHALL display each metric as a selectable control carrying an accessible name that states the metric label and the metric value.
7. THE Overview_View SHALL retrieve the metric set for the active filters in a single request.
8. THE Overview_View SHALL display the active date range and active filters alongside the metrics.
9. IF the active filters match no Daily_Attendance_Record, THEN THE Overview_View SHALL display an empty state naming the active filters.

### Requirement 14: Review — Employee Trends

**User Story:** As an Attendance_Administrator, I want one employee's attendance history summarised, so that I can prepare a conversation with evidence.

#### Acceptance Criteria

1. THE Employee_Trends_View SHALL let a user select one employee and one date range.
2. THE Employee_Trends_View SHALL display, for the selected employee and range, scheduled hours, worked hours, attendance rate, late occurrence count, total late minutes, absence count, time-off days used, overtime hours, break minutes, missing punch count, correction count, and manager notes.
3. THE Employee_Trends_View SHALL display the scheduled-versus-worked comparison per work date.
4. WHEN a user selects a displayed value, THE Employee_Trends_View SHALL open the Daily_Attendance_Record set that produced that value.
5. THE Employee_Trends_View SHALL omit any chart that carries no selectable drill-down and no stated action.
6. THE Employee_Trends_View SHALL retrieve the trend set for the selected employee and range in a single request.

### Requirement 15: Review — Exports

**User Story:** As an Attendance_Administrator, I want CSV exports that match what I am looking at, so that I can share evidence without re-filtering in a spreadsheet.

#### Acceptance Criteria

1. THE Export_Service SHALL produce CSV exports for filtered attendance records, the exception queue, payroll-ready attendance, time-off activity, coverage history, and employee trends.
2. THE Export_Service SHALL apply the filters active in the requesting view to the exported rows.
3. THE Export_Service SHALL produce exported rows in the same order as the requesting view displays those rows.
4. THE Export_Service SHALL enclose every exported field in double quotation marks and SHALL escape embedded double quotation marks by doubling.
5. THE Export_Service SHALL include a header row naming each column.
6. THE Export_Service SHALL include the active date range and active filters in the exported file name.
7. THE Export_Service SHALL derive exported attendance values from the Attendance_Service.
8. IF the active filters match no record, THEN THE Export_Service SHALL produce a file containing the header row and SHALL state that no records matched.
9. THE Export_Service SHALL restrict pay-rate columns and pay-amount columns to Attendance_Administrator requests.

### Requirement 16: Review — Audit Log

**User Story:** As an Attendance_Administrator, I want a readable audit trail, so that every attendance change can be traced to a person and a reason.

#### Acceptance Criteria

1. THE Attendance_Audit_Log SHALL record an entry for every attendance correction, every time-off decision, every coverage override, every review status change, and every payroll processing event.
2. THE Attendance_Audit_Log SHALL record, per entry, the affected employee, work date, field or object changed, previous value, new value, action, actor, timestamp, reason, and related payroll period when a payroll period covers the work date.
3. THE Audit_Log_View SHALL display the recorded fields for each entry.
4. THE Audit_Log_View SHALL present filters for employee, work date range, action, and actor.
5. THE Attendance_Audit_Log SHALL reject updates and deletions of existing entries.
6. IF a write to the Attendance_Audit_Log fails, THEN THE Attendance_Service SHALL leave the attempted change uncommitted and SHALL return the failure reason.
7. THE Audit_Log_View SHALL load entries in pages of at most 100 rows.

### Requirement 17: Universal Needs Attention Inbox

**User Story:** As an Attendance_Administrator, I want one place that lists everything unresolved, so that I know what to handle next without visiting four screens.

#### Acceptance Criteria

1. THE Time_Attendance_Module SHALL present the Needs_Attention_Inbox on every Time & Attendance screen.
2. THE Needs_Attention_Inbox SHALL display a count of unresolved items and SHALL open a compact list when selected.
3. THE Needs_Attention_Inbox SHALL include pending time-off requests, dates whose Coverage_Status is Critical, missing punches, unapproved attendance corrections, unapproved unscheduled work, Payroll_Blocking records, and unresolved Attendance_Exception records.
4. THE Needs_Attention_Inbox SHALL display one item per underlying record, even when that record qualifies under more than one category.
5. THE Needs_Attention_Inbox SHALL display, per item, the category, the affected employee or date, and the reason the item is unresolved.
6. WHEN a user selects an item, THE Needs_Attention_Inbox SHALL navigate to the screen that owns the underlying record and SHALL open that record's detail drawer.
7. THE Needs_Attention_Inbox SHALL order items by category severity and then by age, with Payroll_Blocking and Critical items first.
8. WHERE the signed-in user is not an Attendance_Administrator, THE Needs_Attention_Inbox SHALL include only items belonging to the signed-in Employee.
9. THE Needs_Attention_Inbox SHALL retrieve the whole item set in a single request.
10. WHEN an item's underlying condition is resolved, THE Needs_Attention_Inbox SHALL remove that item from the list on the next refresh.

### Requirement 18: Seven-Day Workforce Health Ribbon

**User Story:** As an Attendance_Administrator, I want a seven-day health strip on the operational screens, so that I can see the week ahead at a glance and drill into any day.

#### Acceptance Criteria

1. THE Time_Attendance_Module SHALL display the Health_Ribbon on the Today_Screen, the Schedule_Screen, and the Time_Off_Coverage_Screen.
2. THE Health_Ribbon SHALL display seven consecutive dates beginning at the current date.
3. THE Health_Ribbon SHALL assign each date exactly one state from Healthy, Warning, Critical, Closed, and No_Schedule.
4. THE Health_Ribbon SHALL assign the state Closed to a date on which the organisation is not open.
5. THE Health_Ribbon SHALL assign the state No_Schedule to an open date on which no published schedule exists.
6. THE Health_Ribbon SHALL derive the states Healthy, Warning, and Critical from the Coverage_Status produced by the Coverage_Service for that date.
7. THE Health_Ribbon SHALL convey each date state using a text label or an icon in addition to colour.
8. WHEN a user selects a date, THE Health_Ribbon SHALL display the scheduled staffing, approved time off, pending requests, missing shifts, overtime risk, and coverage by department for that date.
9. WHERE the selected date is the current date or a past date, THE Health_Ribbon SHALL additionally display the Attendance_Exception records for that date.
10. THE Health_Ribbon SHALL display the same state for a given date on the Today_Screen, the Schedule_Screen, and the Time_Off_Coverage_Screen.
11. THE Health_Ribbon SHALL retrieve the seven-date state set in a single request.

### Requirement 19: Data Flow and Single Source of Truth

**User Story:** As the product owner, I want each concept owned by one part of the system, so that the module cannot report two different answers for the same question.

#### Acceptance Criteria

1. THE Time_Attendance_Module SHALL treat published `employee_schedules` rows as the sole record of expected work.
2. THE Time_Attendance_Module SHALL treat `time_clock_entries` and `time_clock_breaks` rows as the sole record of actual work.
3. THE Time_Attendance_Module SHALL treat approved `pto_requests` rows as the sole record of authorised absence.
4. THE Coverage_Service SHALL derive coverage from published schedules and approved absences only.
5. THE Review_Center SHALL compare expected work against actual work using the Attendance_Service only.
6. THE Payroll_Service SHALL consume worked hours, paid break minutes, and approved absence days from the Attendance_Service.
7. THE Time_Attendance_Module SHALL treat `profiles` and `employee_payment_settings` rows as the sole record of employee, role, department, eligibility, and pay policy configuration.
8. THE Time_Attendance_Module SHALL contain one implementation of the late rule, one implementation of the absence rule, one implementation of the break-deduction rule, one implementation of the scheduled-hours rule, one implementation of the worked-hours rule, one implementation of the working-day count rule, and one implementation of the coverage rule.
9. THE Time_Attendance_Module SHALL contain one implementation of the employee-timezone conversion used for display.
10. THE Time_Attendance_Module SHALL contain one implementation of the mapping from a clock instant to a calendar work date.

### Requirement 20: Performance

**User Story:** As a Time & Attendance user, I want screens that load in one pass, so that the module stays responsive as the roster and history grow.

#### Acceptance Criteria

1. THE Time_Attendance_Module SHALL retrieve the data for a screen without issuing one request per employee.
2. THE Time_Attendance_Module SHALL retrieve the data for a screen without issuing one request per calendar date.
3. THE Team_Today_View SHALL retrieve the whole team attendance set for the current date in a single request.
4. THE Coverage_Calendar SHALL retrieve the whole displayed coverage range in a single request.
5. THE Workforce_Screen SHALL retrieve pay settings for all listed employees in a single request.
6. THE Workforce_Screen SHALL retrieve time-off balances for all listed employees in a single request.
7. WHEN an Attendance_Administrator applies a schedule template to a set of employees, THE Schedule_Screen SHALL submit that set in a single request.
8. THE Exception_Queue SHALL retrieve at most 100 rows per request.
9. THE Time_Attendance_Module SHALL keep at most 90 days of attendance detail in browser memory for any one view.
10. THE Time_Attendance_Module SHALL support an index on `time_clock_entries` that serves date-range queries spanning all employees.
11. THE Time_Attendance_Module SHALL support an index on `employee_schedules` that serves date-range queries spanning all employees.
12. THE Time_Attendance_Module SHALL support an index on `pto_requests` that serves date-range overlap queries spanning all employees.
13. THE Time_Attendance_Module SHALL record the measured query plan for each new date-range query before that query is released.

### Requirement 21: Permissions and Audit Integrity

**User Story:** As the product owner, I want the existing role boundaries preserved and stated, so that the redesign cannot widen access by accident.

#### Acceptance Criteria

1. THE Time_Attendance_Module SHALL let an Employee read and modify only that Employee's own clock entries, break entries, schedule, time-off requests, and time-off balances.
2. THE Time_Attendance_Module SHALL let an Attendance_Administrator read the attendance data of every employee that Attendance_Administrator is authorised to review.
3. THE Time_Attendance_Module SHALL restrict time-off approval and denial to an Attendance_Administrator.
4. THE Time_Attendance_Module SHALL restrict clock-entry correction to an Attendance_Administrator.
5. THE Time_Attendance_Module SHALL restrict schedule creation, amendment, and deletion to an Attendance_Administrator.
6. THE Time_Attendance_Module SHALL restrict pay rates, pay type, overtime policy, deductions, payroll periods, and payroll summaries to an Attendance_Administrator.
7. THE Time_Attendance_Module SHALL reject an Employee's attempt to approve or deny that Employee's own time-off request.
8. THE Time_Attendance_Module SHALL reject an Employee's attempt to resolve an Attendance_Exception recorded against that Employee.
9. THE Time_Attendance_Module SHALL require a stored reason for every manual override of a derived value.
10. THE Time_Attendance_Module SHALL enforce every access rule in this requirement at the API layer and in row level security policies.
11. WHERE the codebase checks for the role `manager`, THE Time_Attendance_Module SHALL also accept the role `super_admin`.
12. THE Time_Attendance_Module SHALL restrict pay rates, hourly pay, payroll settings, clock-entry corrections, time-off approvals, and work schedules to `super_admin`, and SHALL withhold those capabilities from the role `manager`.
13. THE Time_Attendance_Module SHALL let an Employee read that Employee's own payroll summaries and pay settings.
14. THE Time_Attendance_Module SHALL let every signed-in user read the `staffing_thresholds` values required to render coverage status.
15. IF a request would read or modify data outside the signed-in user's permitted set, THEN THE Time_Attendance_Module SHALL return an authorisation failure and SHALL make no change.

### Requirement 22: Visual Design, Responsiveness, and Accessibility

**User Story:** As a Time & Attendance user, I want a compact, legible interface that works on my phone and with a keyboard, so that the module is usable wherever I am.

#### Acceptance Criteria

1. THE Time_Attendance_Module SHALL present record collections as tables or compact lists.
2. THE Time_Attendance_Module SHALL present record detail in a side drawer.
3. THE Time_Attendance_Module SHALL reserve full-screen overlays for destructive confirmations and for viewports below 768 pixels.
4. THE Time_Attendance_Module SHALL display at most one action styled as the primary action per screen region.
5. THE Time_Attendance_Module SHALL apply the colour role Neutral to normal information, Accent to the selected item and the primary action, Healthy to staffing above requirement, Warning to staffing approaching minimum, Critical to staffing below minimum and to Payroll_Blocking records, and Pending to items awaiting review.
6. THE Time_Attendance_Module SHALL accompany every status colour with a text label or an icon.
7. THE Time_Attendance_Module SHALL display the reason for a status as visible text rather than only within a tooltip.
8. THE Time_Attendance_Module SHALL render every screen usably at viewport widths of 360 pixels, 768 pixels, 1024 pixels, and 1440 pixels.
9. THE Time_Attendance_Module SHALL let a keyboard user reach every interactive control using the Tab key and activate that control using the Enter key or the Space key.
10. WHEN a side drawer opens, THE Time_Attendance_Module SHALL move keyboard focus into that drawer and SHALL confine Tab navigation to that drawer while the drawer is open.
11. WHEN a side drawer closes, THE Time_Attendance_Module SHALL return keyboard focus to the control that opened the drawer.
12. THE Time_Attendance_Module SHALL provide an accessible name for every interactive control, status indicator, and metric control.
13. THE Time_Attendance_Module SHALL render body text and status text at a contrast ratio of at least 4.5 to 1 against the surrounding surface.
14. THE Time_Attendance_Module SHALL display a loading state while a screen's data request is outstanding.
15. THE Time_Attendance_Module SHALL display an empty state naming the active filters when a data request returns no records.
16. IF a data request fails, THEN THE Time_Attendance_Module SHALL display the failure reason and SHALL present a retry control.

### Requirement 23: Migration and Rollout Safety

**User Story:** As the product owner, I want the redesign delivered in reversible stages, so that a problem in one stage does not compromise attendance or payroll data.

#### Acceptance Criteria

1. THE Time_Attendance_Module SHALL apply every schema change as a new forward-only migration file.
2. THE Time_Attendance_Module SHALL leave previously released migration files unmodified.
3. THE Time_Attendance_Module SHALL retain all existing rows in `time_clock_entries`, `time_clock_breaks`, `employee_schedules`, `pto_requests`, `pto_balances`, `payroll_periods`, `payroll_summaries`, and `audit_log`.
4. THE Time_Attendance_Module SHALL record the documented pre-redesign calculation rules before the Attendance_Service replaces those rules.
5. WHEN the Attendance_Service is introduced, THE Time_Attendance_Module SHALL demonstrate that Payroll_Service outputs for every already-processed payroll period are unchanged.
6. THE Time_Attendance_Module SHALL remove an obsolete component, route, or navigation identifier only after confirming that no remaining reference to that item exists.
7. THE Time_Attendance_Module SHALL keep cleanup changes in commits separate from behavioural changes.
8. THE Time_Attendance_Module SHALL provide a documented rollback path for each schema change.
9. THE Time_Attendance_Module SHALL deliver automated tests for the Attendance_Service status rules, the Coverage_Service arithmetic, the PTO_Service balance arithmetic, and the Payroll_Service preservation check.

## Correctness Properties

These properties constrain the behaviour defined above and are the basis for the property-based tests specified in Requirement 23, criterion 9.

### Attendance status derivation

1. **Totality.** For every employee and every date in the evaluated range, the Attendance_Service assigns exactly one Derived_Status.
2. **Determinism.** Evaluating the Attendance_Service twice over an unchanged data set produces identical Daily_Attendance_Record values.
3. **Rule attribution.** Every Attendance_Exception carries a rule identifier, and that rule's condition holds for the record that carries the exception.
4. **Non-negative durations.** Worked hours, scheduled hours, paid break minutes, and unpaid break minutes are never negative.
5. **Worked-hours bound.** Worked hours never exceed the elapsed span from the first clock-in to the last clock-out on that date.
6. **Break subtraction.** For a closed clock session, worked hours equal the session span minus that session's unpaid break minutes, and paid break minutes do not reduce worked hours.
7. **Late monotonicity.** Moving a first clock-in later, holding the schedule fixed, never decreases reported late minutes.
8. **Grace boundary.** A first clock-in exactly Grace_Period minutes after the scheduled start does not produce a late condition; a first clock-in one minute later does.
9. **Session independence.** Adding a second clock session on a date changes worked hours and does not change reported late minutes.
10. **Scheduled-hours idempotence.** Scheduled hours for a date depend only on the published schedule for that date and are unchanged by the number of clock sessions recorded on that date.
11. **Timezone stability.** A clock instant maps to the same calendar work date regardless of the timezone of the process performing the evaluation.
12. **Single-source agreement.** Today, Time Off & Coverage, Review, and Payroll report identical Derived_Status, worked hours, and scheduled hours for the same employee and date.

### Coverage projection arithmetic

13. **Projection identity.** Projected_Coverage for a date equals the scheduled count minus the approved-absence count minus the proposed-absence count.
14. **Non-negativity.** Reported available staffing and reported missing headcount are never negative.
15. **Absence monotonicity.** Adding one approved absence on a date decreases Projected_Coverage for that date by exactly one and never increases it.
16. **Interval partition.** The Coverage_Interval set for a date is contiguous, non-overlapping, and spans the union of the scheduled shifts on that date.
17. **Interval consistency.** The minimum available staffing across a date's Coverage_Intervals is less than or equal to the date's whole-day available staffing.
18. **Status ordering.** Coverage_Status is a monotone function of available staffing relative to required staffing: decreasing available staffing never improves Coverage_Status.
19. **Live and projected separation.** Projected_Coverage for a future date is unchanged by any clock entry.
20. **Ribbon agreement.** The Health_Ribbon state for a date equals the Coverage_Service state for that date on every screen that renders the ribbon.
21. **Decision consistency.** After a leave decision is committed, the recomputed Projected_Coverage for each affected date equals the value the Approval_Impact_Preview displayed for that date before the decision.

### Time-off balance arithmetic

22. **Debit identity.** Approving a request debits the balance for the requested type by exactly the number of approved working days.
23. **Reversal.** Denying or cancelling a previously approved request restores the balance to the value it held before that approval.
24. **Round trip.** Approve followed by cancel returns the balance for every affected year to its pre-approval value.
25. **Idempotence.** Submitting the same decision for the same request more than once produces the same balance as submitting that decision once.
26. **Year attribution.** The sum of per-year debits for an approved request equals the total approved working days, and each date's debit is attributed to the calendar year containing that date.
27. **Working-day agreement.** The working-day count computed at submission equals the working-day count computed at decision time for the same date range.
28. **Atomicity.** A request status change and its balance change either both persist or neither persists.
29. **Concurrency.** Two concurrent decisions on distinct requests for the same employee produce a final balance equal to the sum of both debits.

### Correction and approval auditing

30. **Audit completeness.** Every committed correction, decision, override, and review status change produces exactly one Attendance_Audit_Log entry.
31. **Audit immutability.** Existing Attendance_Audit_Log entries are never updated or deleted.
32. **Reason presence.** Every entry recording a manual override or correction carries a non-empty reason.
33. **Correction idempotence.** Submitting an identical correction twice leaves the Daily_Attendance_Record in the same state as submitting it once, and the second submission is recorded as a distinct audit entry.
34. **Review idempotence.** Marking a record reviewed more than once retains the first review actor and timestamp.
35. **Recompute coupling.** After a correction is committed, the next read of the affected Daily_Attendance_Record reflects that correction.
36. **Duplicate suppression.** A record appearing in several Needs_Attention_Inbox categories yields exactly one inbox item.

### Payroll preservation

37. **Output equality.** For every already-processed payroll period, the Payroll_Service produces the same regular hours, overtime hours, break hours, total hours, PTO days, gross pay, deductions total, and net pay after the redesign as the stored `payroll_summaries` rows record.
38. **Input isolation.** Changing an Attendance_Service presentation concern does not change any Payroll_Service output value.
39. **Locked-period immutability.** A correction to a date inside a processed payroll period does not alter that period's stored `payroll_summaries` rows.
40. **Blocking visibility.** Every Daily_Attendance_Record that the Payroll_Service excludes from paid hours appears in the Exception_Queue under the payroll blocking filter.
41. **Rounding stability.** Recomputing a payroll period from unchanged inputs produces byte-identical monetary values.

---

## Appendix A — Current System Audit

This appendix records the pre-redesign system as read from the repository. It is the reference for Requirement 2 (preservation), Requirement 19 (single source of truth), and Correctness Property 37 (payroll preservation).

### A.1 Composition and navigation

The Time & Attendance module has no dedicated Next.js route. `RoleWorkspace` (`src/components/role-workspace.tsx`) renders `SidebarLayout`, maps the sidebar sub-navigation identifier to a section string, and passes that string to `TimeAttendanceWorkspace` as `activeSection`. Navigation state lives in React state only; there is no URL, no query parameter, and no deep link. Any requirement to open a specific record from an inbox needs navigation state that does not exist today (Requirement 1, criterion 11).

`app-sidebar.tsx` exposes the module to every role (`permissions.timeAttendance` is a hardcoded `true`) with three base items (`ta_clock`, `ta_schedule`, `ta_pto`) and four administrator items (`ta_payroll`, `ta_staffing`, `ta_workforce`, `ta_reports`).

`TimeAttendanceWorkspace` renders `TimeClock`, `ScheduleManager`, `PTORequests` for all roles, and gates `PayrollDashboard` + `PayrollProcessor`, `StaffingCoverage`, `WorkforceAdmin`, `AttendanceReports` behind `canAdministerAttendance`.

### A.2 Permissions as they stand

`canAdministerAttendance(role)` delegates to `isSuperAdminRole(role)`, so it resolves to `super_admin` only. `isBroadManagerRole` (manager plus super_admin) is used for user administration and other modules but not for attendance.

`v1.6.2-enforce-scoped-supervisor-access.sql` is the most recent migration to touch Time & Attendance row level security and it supersedes `v1.5.0-fix-pto-rls-super-admin.sql`. Its stated intent is recorded in the file: all roles are employees in Time & Attendance and only Super Admin administers it. The resulting policies are:

| Table | Non-administrator access | Administrator access |
| --- | --- | --- |
| `time_clock_entries` | select own, insert own, update own | `super_admin` all |
| `time_clock_breaks` | select own via parent entry, insert own, update own | `super_admin` all |
| `employee_schedules` | select own | `super_admin` all |
| `pto_requests` | select own, insert own, update own while pending | `super_admin` all |
| `pto_balances` | select own | `super_admin` all |
| `payroll_periods` | none | `super_admin` all |
| `payroll_summaries` | none | `super_admin` all |
| `employee_payment_settings` | none | `super_admin` all |
| `staffing_thresholds` | none | `super_admin` all |

Two consequences follow. First, the manager-facing approval and correction flows described in the redesign brief have no authorisation basis today; see Appendix B, Open Question 1. Second, `v1.6.2` removed the self-select policies that `v1.2.0` had granted on `payroll_summaries`, `employee_payment_settings`, and `payroll_periods`, and removed the public select on `staffing_thresholds`. `PayrollDashboard` is written as an employee self-service view ("My Payment Info", "Payroll History") but is both gated to administrators in the workspace and unable to return rows for anyone else. `/api/payroll/settings` compounds this by returning a hardcoded default object with a null rate when no row is readable, so a non-administrator receives plausible-looking empty settings rather than an authorisation failure. Requirement 21, criteria 13 and 14 restore the intended employee reads.

### A.3 Database objects

`v1.2.0-time-attendance.sql` creates nine tables. Later migrations touching them are `v1.3.1` (super-admin policies, superseded), `v1.5.0` (PTO policies, superseded), `v1.6.2` (current policies), `v1.7.0` (purge: deletes all clock entries, breaks, PTO requests, payroll periods and summaries, and all schedules; zeroes balance usage), `v1.7.1` (seeds schedules for 2026-07-28 to 2026-08-31), and `v1.7.3` (adds `profiles.timezone`, rewrites `shift_end` 17:50 to 17:30).

Enumerations enforced by check constraints:

- `time_clock_entries.clock_status`: `available`, `lunch`, `unavailable`
- `time_clock_breaks.break_type`: `lunch`, `short`, `personal`
- `employee_schedules.shift_type`: `regular`, `overtime`, `half_day`, `training`, `on_call`
- `employee_schedules.status`: `scheduled`, `published`, `completed`, `missed`, `cancelled`
- `pto_requests.pto_type`: `vacation`, `sick`, `personal`, `bereavement`, `unpaid`
- `pto_requests.status`: `pending`, `approved`, `denied`, `cancelled`
- `payroll_periods.payment_template`: `monthly`, `biweekly`, `semi_monthly`
- `payroll_periods.status`: `open`, `locked`, `processed`, `paid`
- `employee_payment_settings.pay_type`: `hourly`, `salary`
- `payroll_summaries.status`: `draft`, `confirmed`, `paid`
- `staffing_thresholds.department`: `sales`, `customer_service`, `commercial`, `management`
- `staffing_thresholds.time_slot`: `morning`, `afternoon`, `full_day`

Key constraints: `employee_schedules` carries `unique (profile_id, schedule_date)`, so the data model permits exactly one shift per employee per day. Split shifts cannot be represented, which limits how much interval detail Requirement 9, criterion 4 can extract from schedule data alone. `pto_balances` carries `unique (profile_id, year)`. `payroll_summaries` carries `unique (payroll_period_id, profile_id)`.

Indexes present: `idx_time_clock_profile_date (profile_id, clock_in desc)`, partial `idx_time_clock_active (profile_id) where clock_out is null`, `idx_time_clock_breaks_entry`, `idx_employee_schedules_date (schedule_date, profile_id)`, `idx_employee_schedules_profile (profile_id, schedule_date)`, `idx_pto_requests_profile (profile_id, start_date)`, partial `idx_pto_requests_pending`, `idx_payroll_periods_dates`, `idx_payroll_summaries_period`, `idx_payroll_summaries_profile`. There is no index that serves a clock-entry date-range query spanning all employees, which is the access pattern Today, Review, and Coverage all need (Requirement 20, criterion 10).

No RPC, view, materialised view, or trigger exists for Time & Attendance beyond the `touch_updated_at` timestamp triggers. Every calculation described below lives in TypeScript.

No migration inserts `staffing_thresholds` rows. The table is therefore expected to be empty in production, and `/api/staffing` silently substitutes `{ minimum_staff: 1, warning_threshold: 2 }` for every department. Coverage status displayed today is not based on configured requirements.

`audit_log` exists in `supabase/schema.sql` with columns `actor_profile_id`, `action`, `entity_type`, `entity_id`, `old_value`, `new_value`, `reason`, `created_at`. Within Time & Attendance it is written by exactly one code path, `/api/payroll/process`. Clock corrections and time-off decisions write no audit row; the only trace of a clock correction is the `adjusted_by` and `adjustment_reason` columns on the entry itself, which are overwritten by the next correction.

### A.4 API surface

| Route | Methods | Authorisation | Purpose |
| --- | --- | --- | --- |
| `/api/time-clock` | GET, POST, PATCH | GET: own unless administrator; POST: self; PATCH `clock_out`: self; PATCH `edit`: administrator | List entries, clock in, clock out, correct an entry |
| `/api/time-clock/active` | GET | self | Current open entry and open break |
| `/api/time-clock/breaks` | POST, PATCH | self | Start and end a break |
| `/api/time-clock/reports` | GET | administrator | Lateness, break, and adherence analytics |
| `/api/schedules` | GET, POST, DELETE | GET: own unless administrator; write: administrator | Read, upsert, delete shifts |
| `/api/pto` | GET, POST, PATCH | GET: own unless administrator; POST: self; PATCH: administrator | List, submit, decide requests |
| `/api/pto/balance` | GET, POST | GET: own unless administrator; POST: administrator | Read and set allocations |
| `/api/staffing` | GET | administrator | Live coverage |
| `/api/payroll` | GET | own unless administrator | Payroll summaries |
| `/api/payroll/periods` | GET, POST | administrator | List and create periods |
| `/api/payroll/settings` | GET, POST | GET: own unless administrator; POST: administrator | Read and set pay settings |
| `/api/payroll/calculate` | GET | administrator | Compute a period |
| `/api/payroll/process` | POST | administrator | Persist and lock a period |

No realtime subscription exists in Time & Attendance. `StaffingCoverage` polls `/api/staffing` every 30 seconds. Every other screen fetches on mount and on explicit refresh.

### A.5 Current calculation rules

**Worked hours.** On clock-out, `/api/time-clock` PATCH computes `total_hours = round(((clock_out - clock_in) / 60000 - break_minutes) / 60, 2)` and stores it on the entry. The administrator `edit` action recomputes with the same formula, but only when both `clock_in` and `clock_out` are present. While an entry is open, `total_hours` is null and `TimeClock.tsx` shows a client-side stopwatch of `Date.now() - clock_in` that does not subtract break time, so the live figure and the figure persisted a moment later disagree by the break duration.

**Break duration.** Ending a break stores `duration_minutes = round((break_end - break_start) / 60000)` on the break row. Only breaks of type `lunch` are added to `time_clock_entries.break_minutes`; `short` and `personal` breaks are recorded but never deducted, which `/api/time-clock/breaks` documents as paid. Clocking out while a break is open force-closes that break with `duration_minutes: 0` and does not increment `break_minutes`, so an open lunch break at clock-out becomes paid time. `/api/time-clock/reports` prefers the summed `time_clock_breaks.duration_minutes` over `break_minutes`, so the break total shown in Reports includes paid short breaks while the break total used by payroll does not. `clock_status` is set to `lunch` for every break type and reset to `available` on break end, so the stored status cannot distinguish a lunch from a short break.

**Scheduled hours.** Computed only in `/api/time-clock/reports`, as `shift_end - shift_start` in hours, accumulated once **per clock entry** rather than once per date. An employee with two clock sessions on a scheduled day contributes that day's scheduled hours twice, which inflates scheduled hours and deflates adherence. The parse `new Date(\`${date}T${shift_start}\`)` has no timezone designator and therefore resolves in the server process timezone, while schedules are documented as US Eastern.

**Paid hours and payroll totals.** `/api/payroll/calculate` sums `total_hours` across entries in the window that have a non-null `clock_out`; entries with a missing clock-out are silently excluded with no warning and no block. Overtime is not weekly: the route computes `periodDays` inclusive, `weeks = periodDays / 7`, `regularCap = weeks * weekly_overtime_threshold` (default 40), `regular = min(total, regularCap)`, `overtime = max(0, total - regularCap)`. The `is_overtime` column on `time_clock_entries` is never set by any code path yet `/api/time-clock/reports` uses it to split actual hours from overtime hours, so reported overtime in Reports is always zero. PTO pay is `pto_days_used * 8 * hourly_rate`, where `pto_days_used` sums `total_days` for every approved request that overlaps the period, counting the whole request even when only part of it falls inside the period. Gross pay is `regular_pay + overtime_pay + pto_pay`; deductions come from the `employee_payment_settings.deductions` JSON array as fixed amounts or percentages of gross; net pay is gross minus deductions. Each output is rounded to two decimals. Employees with no hours and no PTO are filtered out. `pay_type` of `salary` is stored but never read, so salaried staff calculate to zero pay. `/api/payroll/process` trusts the summary values submitted by the browser rather than recomputing server-side, deletes and re-inserts summaries when reprocessing a period, and writes `days_absent: 0` and `days_late: 0` unconditionally.

**Late.** Three implementations disagree. `TimeClock.tsx` `isLate` treats a clock-in more than five minutes after `shift_start` as late, builds the scheduled instant with `setHours` on the clock-in date in browser-local time, applies the test to the first entry of the day only, and depends on a schedule fetch that runs only for administrators. `/api/time-clock/reports` applies the same five-minute threshold but parses the scheduled instant in server-local time and counts a late occurrence **per entry**, so a second clock-in later in the day can register as an additional lateness. `payroll_summaries.days_late` is written as the literal zero.

**Absence.** Not implemented anywhere. No code path compares a published schedule against the absence of clock entries. `payroll_summaries.days_absent` is written as the literal zero.

**Time-off balances.** Allocations live in `pto_balances`, defaulting to 10 vacation days, 5 sick days, and 3 personal days; the UI reinterprets `personal_days` as a single birthday day and hides sick entirely. On approval, `/api/pto` PATCH recounts Monday-to-Friday days between the stored start and end dates and increments `vacation_used`, `sick_used`, or `personal_used`, where `personal_used` receives everything that is neither vacation nor sick. The increment is a read-then-write pair with no atomic operation, so concurrent approvals can lose an increment; failures are only written to `console.error` while the endpoint still reports success. The year bucket is `new Date().getFullYear()`, the year the decision is taken rather than the year of the requested dates, so a December approval of January leave debits the wrong year. Denying or cancelling a previously approved request does not restore the balance; there is no reversal path. `PTORequests.tsx` displays remaining vacation as `vacation_days - vacation_used` and remaining birthday as `max(0, 1 - personal_used)`, hardcoding one day and ignoring the `personal_days` allocation that `WorkforceAdmin` lets an administrator edit. `carryover_days` is stored and never read. The two-week notice rule is a client-side warning only; the server accepts any date. `total_days` is trusted from the client on insert and recomputed on approval.

**Coverage.** `/api/staffing` is the only implementation and is entirely present-tense. It counts `time_clock_entries` rows with `clock_out IS NULL`, maps `profiles.role` to a department through `roleToDepartment`, and compares the count against `staffing_thresholds` for today's day of week and the current time slot (`morning` when the server hour is below 12, otherwise `afternoon`), falling back to minimum 1 and warning 2. Status is `critical` when the count is below minimum, `warning` when the count is at or below the warning threshold, otherwise `ok`. The card headline shows the total clocked-in count while a separate `available` count tracks `clock_status = 'available'`, so an employee on lunch still counts toward coverage. Schedules and approved absences are not consulted, and no forecast exists for any future date. The Approval Impact Preview required by Requirement 9 has no precursor in the codebase.

**Timezones.** `profiles.timezone` was added in `v1.7.3` with values `America/New_York`, `America/Guayaquil`, and `America/Tegucigalpa`. It is read in exactly one place, `ScheduleManager.tsx`, which applies hardcoded offsets of minus one hour for Guayaquil and minus two hours for Tegucigalpa against a hardcoded Eastern Daylight Time baseline, for display only and with no daylight-saving handling. Every other surface ignores the column, and server-side date arithmetic uses the server process timezone.

**Work-date bucketing.** Two conventions coexist. `TimeClock.tsx` and the payroll detail modal use `new Date(entry.clock_in).toISOString().split('T')[0]`, which yields the UTC date. `/api/time-clock/reports` and `WorkforceAdmin` use `entry.clock_in.split('T')[0]`, which yields the date as stored in the timestamp string. Near midnight the two conventions assign the same clock entry to different dates.

### A.6 Duplicate and inconsistent calculations

| Concept | Implementations found | Disagreement |
| --- | --- | --- |
| Late | `TimeClock.tsx` `isLate`; `/api/time-clock/reports`; `payroll_summaries.days_late` | First-entry-only versus per-entry versus hardcoded zero; browser-local versus server-local instant construction |
| Break total | `time_clock_entries.break_minutes` (lunch only); `/api/time-clock/reports` `breakMap` (all break types) | Payroll deducts lunch only; Reports displays all breaks |
| Worked hours | Persisted `total_hours`; live stopwatch in `TimeClock.tsx`; over-10-hour heuristic in `PayrollProcessor.tsx` | Stopwatch omits break deduction |
| Scheduled hours | `/api/time-clock/reports` only | Accumulated per entry rather than per date |
| Overtime | `/api/payroll/calculate` period-average cap; `is_overtime` column; `/api/time-clock/reports` split by `is_overtime` | Column is never written, so Reports overtime is always zero and payroll overtime uses a period cap rather than a weekly cap |
| Working-day count | `PTORequests.tsx` `countWeekdays`; `/api/pto` `countWeekdays` | Two copies of the same algorithm |
| Coverage | `/api/staffing` only | Present-tense only; no projection |
| Timezone conversion | `ScheduleManager.tsx` hardcoded offsets | Ignored everywhere else; no daylight-saving handling |
| Work-date bucketing | UTC-date convention and raw-string convention | Different date assignment near midnight |
| PTO type vocabulary | `types.ts` `PTOType = 'vacation' \| 'birthday'`; database check constraint `vacation \| sick \| personal \| bereavement \| unpaid` | `PTORequests.tsx` builds its type selector from `PTO_TYPE_LABELS` and can submit `birthday`, which the check constraint rejects |

### A.7 Exports and tests

Only two exports exist, both built in the browser inside `PayrollProcessor.tsx`: the current calculation and a historical period. The historical export quotes only the employee name; the current-calculation export quotes nothing, so any comma in a value corrupts the row. `AttendanceReports.tsx` has no export at all. Requirement 15 replaces both with a server-side Export_Service.

`vitest` 4.1.10 and `fast-check` 4.9.0 are installed and `vitest.config.ts` targets `src/**/*.{test,spec}.{ts,tsx}` in a node environment. Twenty-one test files exist across `cs-intake`, `notifications`, `quotes`, and `rotation`. None cover Time & Attendance. `package.json` declares no `test` script, so tests are run with `npx vitest --run`.

---

## Appendix B — Open Questions

### Open Question 1 — Manager access to Time & Attendance administration (blocking)

The redesign brief describes a manager-facing Team Today view, manager time-off approval and denial, manager attendance correction, and a manager coverage override. The repository grants none of those capabilities to the `manager` role:

- `canAdministerAttendance` resolves to `super_admin` only.
- `v1.6.2-enforce-scoped-supervisor-access.sql`, the most recent Time & Attendance security migration, states in the file that all roles are employees in Time & Attendance and only Super Admin administers it, and its policies grant administration to `super_admin` only.
- The workspace rule set states that pay rates, hourly pay, payroll settings, clock-in edits, time-off approvals, and work schedules are `super_admin`-exclusive and are not shared with `manager`, while also requiring that a plain `manager` role check accept `super_admin`.

This document currently reads "Attendance_Administrator" as `super_admin` only (Requirement 21, criterion 12), which preserves the deployed security model and satisfies the exclusivity rule. Under that reading, "manager view" in the brief means "the administrator view" and no new role gains approval or correction rights.

A decision is needed between three options:

1. **Preserve.** Attendance_Administrator stays `super_admin` only. Team Today, approvals, corrections, and overrides remain `super_admin`-exclusive. No migration is required. This is the current text of Requirement 21.
2. **Extend read-only.** `manager` gains read access to team attendance, coverage, and the Review queue, but no approval, correction, schedule, or pay capability. Requires a forward-only migration adding `manager` to the select policies on `time_clock_entries`, `employee_schedules`, `pto_requests`, and `staffing_thresholds`, and a new permission predicate distinct from `canAdministerAttendance`.
3. **Extend fully.** `manager` gains time-off approval and attendance correction while pay and payroll stay `super_admin`-exclusive. This contradicts the current exclusivity rule and requires that rule to be amended before implementation.

Requirement 21 will be updated to match the option chosen.

### Open Question 2 — Split shifts and interval-level coverage

`employee_schedules` enforces `unique (profile_id, schedule_date)`, so an employee can hold only one shift per date. Requirement 9, criterion 4 asks for interval-level availability, which the current model can express only through differing start and end times across employees, not through a lunch window or a mid-day gap for a single employee. Confirm whether the interval breakdown should be limited to what one shift per employee per day can express, or whether the schedule model should gain either multiple shifts per date or an explicit unpaid-break window. The second choice changes the Schedule screen and therefore touches a preserved area.

### Open Question 3 — Staffing thresholds are unconfigured

No migration seeds `staffing_thresholds`, so coverage status today is computed against a hardcoded minimum of 1 and warning of 2 for every department. Requirement 6, criterion 4 currently treats an unconfigured department as Healthy so that the redesign does not invent requirements. Confirm the intended minimum staffing per department, day of week, and time slot, and whether the redesign should include a seed migration and a threshold editor on the Workforce screen.

### Open Question 4 — Time-off type vocabulary

The TypeScript type declares `vacation` and `birthday`; the database check constraint accepts `vacation`, `sick`, `personal`, `bereavement`, and `unpaid`. A submission of `birthday` is rejected by the constraint, and the approval path maps everything that is not vacation or sick into `personal_used`. Confirm the intended set of request types, and whether `birthday` should become a first-class constraint value through a forward-only migration or remain mapped onto `personal`.

### Open Question 5 — Overtime rule

`/api/payroll/calculate` applies a period-average cap of `(period days / 7) x weekly threshold` rather than a per-week threshold, and `time_clock_entries.is_overtime` is never written. Requirement 2, criterion 4 requires that payroll outputs remain unchanged, so this document preserves the period-average rule. Confirm whether the period-average behaviour is intended or whether a corrected weekly rule should be scheduled as a separately approved payroll change under Requirement 2, criterion 6.

### Open Question 6 — Attendance visibility scope for administrators

Requirement 21, criterion 2 refers to "every employee that Attendance_Administrator is authorised to review". `super_admin` currently sees every employee, and no manager-to-team relationship exists in `profiles`. Confirm whether a team or department scoping concept should be introduced, or whether administrator visibility remains organisation-wide.

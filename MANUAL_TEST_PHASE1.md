# Manual Test Cases

Local app: http://localhost:3000

All demo accounts use password: `TestPass1!`

## Accounts

| Actor | Email |
| --- | --- |
| Company Admin | `admin@oceangrill.com` |
| Kitchen Manager | `sarah@oceangrill.com` |
| Bar Manager | `marcus@oceangrill.com` |
| Kitchen Staff | `alex@oceangrill.com` |
| Kitchen Staff | `jamie@oceangrill.com` |
| Front of House Staff | `casey@oceangrill.com` |

---

# End-to-End Actor Flows

Use these flows when you want to test the whole application in actor order. Run the Company Admin flow first, then continue with Manager and Staff using the same organization and tasks. The Platform Admin flow is separate from normal organization operations.

## Company Admin Flow

1. Log in as `admin@oceangrill.com` with password `TestPass1!`.
2. Open the Ocean Grill organization dashboard and confirm the organization is active.
3. Open Departments and create or verify Kitchen, Bar, and Front of House departments.
4. Open Members and confirm the Managers and Staff members are active and assigned to the expected departments.
5. Open Settings and confirm automatic allocation is selected.
6. Adjust Ranking Priorities, save them, reload the page, and confirm the values are normalized to a total of `100%`. (must put a max to 100 only)
7. Open Certification Definitions and create or verify Food Safety Level 2, RSA Certification, and First Aid. (company admin Configure certification types or requirements used by the organization, such as which certifications exist, which departments use them, and which tasks require them)
8. Assign required certifications to the appropriate departments. (add in auto mode too)
9. Open Work Rules and create or verify a daily or weekly hour rule.
10. Open Roles and create a custom role with selected permissions, then assign it to a Manager or Staff member. (add in auto mode too)
11. Open Members and invite a new Manager or Staff member, or update an existing member's role and department. (add in supabase invitation too)
12. Open Certification Definitions to maintain organization requirements. Certification submissions are reviewed by Managers, not Company Admins.
13. Open Tasks or Dashboard and inspect tasks created by the Manager, including assignments and allocation explanations.
14. Open Calendar, Reports, Audit Log, and Notifications to confirm organization activity is visible. (calendar make sure to add a hover or click to pop a small details)
15. Open Settings again and confirm all saved organization configuration remains after navigation and reload.

Expected result:
- Company Admin can manage organization configuration, members, departments, certifications, work rules, roles, and permissions.
- Company Admin can inspect organization-wide operational results.
- Company Admin is not required to manually perform every allocation step when automatic allocation is enabled.

## Manager Flow

1. Log in as `sarah@oceangrill.com` for Kitchen or `marcus@oceangrill.com` for Bar.
2. Open the Manager dashboard and confirm only the assigned department's operational information is visible. (add in like a small note that says the manager's deaprtment on dashboard)
3. Open Tasks and enter a natural-language request such as `Prepare the kitchen for dinner service at 5 PM. Use the west entrance. Food Safety Level 2 required.` (required certifications fail and also if the instructions is clear just auto create the task without showing the detail request again because it will make the manager to review again even though its already clear)
4. Let the AI-assisted task form parse the request, then review the title, department, schedule, location, instructions, headcount, and certification requirements. (create task button so laggy)
5. Create the task and confirm automatic allocation assigns eligible Staff without requiring Staff acceptance.
6. Open the task's eligibility and suggestion views and inspect the eligible candidates, ranking order, factor explanations, and ineligible reasons.
7. Create a second task and use the manual assignment option to select an eligible Staff member from the same ranked candidate list. (department dropdown why still show other department and the smart suggestions should not require another step to take, so during the form fill in at the end, place a section that the ai will auto suggest rather than create task then click another assign button which take alot of time)
8. Open Calendar and confirm the task, assignment, availability, and department coverage are visible. 
9. Open Certifications and review pending Staff submissions within the Manager's department.
10. Verify one valid certification and reject one invalid certification with a reason.
11. Ask the assigned Staff member to submit a withdrawal request before clock-in, then review and approve or deny it.
12. Repeat the withdrawal flow after the Staff member clocks in and confirm worked-time evidence is preserved.
13. If a withdrawal is approved, confirm the system attempts replacement allocation and reports when no eligible replacement exists.
14. Open Reports, Hour Alerts, Dashboard Insights, and Notifications to inspect workload and allocation outcomes.
15. Attempt to access another department's task, certification, or staff record directly.

Expected result:
- AI assists with task creation and ranking, while the Manager reviews critical decisions.
- Automatic and manual allocation use the same eligibility rules.
- Manager actions are limited to assigned department scope.
- Managers can review certifications and withdrawal requests but cannot manage organization-wide settings unless explicitly granted permission.

## Staff Member Flow

1. Log in as `alex@oceangrill.com`, `jamie@oceangrill.com`, or `casey@oceangrill.com`.
2. Open My Availability and save the correct weekly availability when the Staff member's employment type requires it.
3. Open My Certifications and submit evidence for an active certification definition.
4. Open My Tasks and confirm an automatically assigned task appears without an accept or reject step.
5. Open the task and inspect its department, schedule, location, instructions, certification requirements, and current assignment state. (no details provided ux problem)
6. Before starting, submit a withdrawal request on a test assignment and wait for the Manager's decision.
7. On an approved withdrawal, confirm the assignment leaves the Staff member's active work list and a replacement may be selected.
8. On a denied withdrawal, start the assignment normally.
9. Clock in to the assignment and confirm the status changes to `in_progress`.
10. Clock out and confirm the worked duration is recorded.
11. Complete the assignment and confirm only the Staff member's own assignment is completed.
12. Open Notifications and confirm task, certification, withdrawal, and decision notifications are visible.
13. Attempt to open another Staff member's assignment, certification, availability, or private record.
14. Attempt to open an ungranted organization management page or submit an organization-level mutation. (add calendar for staff as well so that they can have the full skim check for each department)

Expected result:
- Staff can view and manage their own work lifecycle and personal records.
- Staff do not accept or reject assignments before working.
- Staff cannot bypass eligibility, department, ownership, or custom-permission restrictions.
- Staff cannot access another Staff member's private records.

## Platform Admin Flow

1. Log in as `platform@smarttask.com` with password `TestPass1!`.
2. Open the Platform Admin dashboard and inspect organization statistics.
3. Open Organizations and search for Ocean Grill.
4. Open the organization details and inspect permitted tenant information.
5. Activate, deactivate, or restore a disposable test organization if that operation is required for the test.
6. Open Templates and inspect available industry templates.
7. Confirm Platform Admin does not see or perform normal organization task allocation, Staff clocking, certification review, or Manager withdrawal workflows.

Expected result:
- Platform Admin can manage platform-level tenant and template information.
- Platform Admin is separated from normal organization operations unless a dedicated platform function explicitly permits access.

## AI And System Allocation Flow

1. A Manager creates a task with department, schedule, headcount, and requirements.
2. The system evaluates active Staff eligibility before ranking.
3. Ineligible Staff are excluded with reasons such as wrong department, unavailable schedule, conflicting assignment, missing certification, or hour-limit risk.
4. The system loads the organization's Ranking Priorities.
5. AI ranks the eligible candidates using those priorities, or the deterministic ranker takes over if AI is unavailable.
6. Automatic allocation selects the highest-ranked eligible candidates according to required headcount.
7. The system rechecks eligibility and headcount before saving assignments.
8. The assigned Staff member receives a notification and sees the task in My Tasks.
9. The system records relevant audit and allocation activity.

Expected result:
- AI reduces manual allocation work without controlling eligibility.
- No ranking priority can make an ineligible Staff member assignable.
- AI failure does not stop allocation; the weighted deterministic fallback remains available.

---

# Phase 1: Auto-Assigned Task Lifecycle

## Company Admin

### CA-P1-01: Settings Default Is Automatic Allocation

1. Log in as `admin@oceangrill.com`.
2. Open Ocean Grill.
3. Go to organization Settings.
4. Find allocation settings.

Expected:
- Automatic allocation is selected by default.
- Only `Automatic` and `Manual` choices are visible.
- There is no `Suggested` allocation mode.
- There is no task acceptance mode setting.

### CA-P1-02: Automatic Allocation Creates Active Assignments

1. Stay logged in as `admin@oceangrill.com`.
2. Ensure allocation mode is Automatic.
3. Create a new task with department, schedule, and required headcount.
4. Save the task.

Expected:
- The system attempts smart allocation automatically.
- Any assigned staff appear immediately as assigned.
- No staff acceptance step is required.

### CA-P1-03: Dashboard Language

1. Stay logged in as `admin@oceangrill.com`.
2. Open the dashboard.
3. Review assignment metrics and staff/task sections.

Expected:
- Dashboard shows assigned, in progress, clocked out, and completed counts.
- There is no acceptance rate.
- There are no pending acceptance or assignment rejection trend widgets.
- Certification pending/rejected language still exists where relevant, because managers review certifications.

## Manager

### Conversational task execution

1. Log in as a manager assigned to a department.
2. Open the Tasks page and type a complete request into the AI command bar, for example: `Need 1 kitchen staff tomorrow morning for prep`.
3. Submit the request.
4. Confirm that the system creates the task without opening the manual task form.
5. Confirm that eligible staff are assigned automatically when the organisation uses automatic allocation.
6. Confirm that the response names the assigned staff and the task list refreshes.
7. Submit an ambiguous request without a department, for example: `I need someone tomorrow morning`.
8. Confirm that the system asks which department should handle it and does not create a task.
9. Submit a request for another department and confirm that the manager receives a scope review message.
10. Confirm that the task page shows only the manager's authorised departments.
11. For a manager assigned to only one department, submit `I need one staff member tomorrow morning for preparation` without naming a department.
12. Confirm that the system uses the manager's only department automatically.
13. For a manager assigned to two departments, submit the same request without naming a department.
14. Confirm that the system shows only those two departments as clarification choices and preserves the original request.

### MG-P1-01: Manual Assignment Still Uses Eligibility

1. Log in as `sarah@oceangrill.com`.
2. Open Tasks.
3. Open a Kitchen task that needs staff.
4. Use manual assignment / assign staff.

Expected:
- Eligible staff are ranked or shown with eligibility checks.
- Managers and company admins are not valid staff candidates.
- Assigned staff become active immediately with `assigned` status.

### MG-P1-02: Manager Reviews Withdrawal

Precondition:
- A staff member has submitted a withdrawal request.

Steps:
1. Log in as `sarah@oceangrill.com`.
2. Go to the manager dashboard, notifications, or task detail where withdrawal review is surfaced.
3. Approve or deny the pending withdrawal request.

Expected:
- Manager can review the request.
- Denial returns the assignment to assigned work.
- Approval removes the staff member from the active slot for now.
- A notification/audit entry is created.

Note:
- Preserving full withdrawal history and automatic replacement after approval are still later-phase items in the checklist.

## Staff

### ST-P1-01: Staff Does Not Accept Or Reject Assigned Work

1. Log in as `alex@oceangrill.com`.
2. Go to My Tasks.
3. Open the active/upcoming task list.

Expected:
- Assigned tasks are already visible as active work.
- There are no `Accept` or `Reject` buttons.
- Available actions are lifecycle actions such as `Clock In` or `Request withdrawal`.

### ST-P1-02: Assignment Lifecycle

1. Stay logged in as `alex@oceangrill.com`.
2. On an assigned task, click `Clock In`.
3. Confirm the task moves to an in-progress state.
4. Click `Clock Out`.
5. Confirm the task moves to an awaiting-completion / clocked-out state.
6. Click `Complete`.

Expected:
- Status moves `assigned -> in_progress -> clocked_out -> completed`.
- The task never asks for staff acceptance.
- Completed task appears in completed/inactive history, not active work.

### ST-P1-03: Withdrawal Requires Manager Review

1. Log in as a staff user with an assigned task, for example `jamie@oceangrill.com`.
2. Go to My Tasks.
3. Click `Request withdrawal`.
4. Enter a clear reason and submit.

Expected:
- Task changes to withdrawal requested.
- The task slot remains reserved while waiting for review.
- Staff cannot submit an empty reason.

### ST-P1-04: Staff Notifications

1. Trigger one assignment or withdrawal action.
2. Open the notification bell/page as the related staff user.

Expected:
- Assignment and withdrawal notifications appear.
- There are no assignment accepted or assignment rejected notification types.

## System / API Smoke Checks

### SYS-P1-01: Removed Accept And Reject Routes

Use the browser or API client while logged in.

Expected:
- `/api/assignments/{assignmentId}/accept` is no longer available.
- `/api/assignments/{assignmentId}/reject` is no longer available.
- Clock-in, clock-out, complete, withdraw, and withdrawal review routes still work.

---

# Phase 2: Withdrawal History And Review Integrity

## Company Admin

### CA-P2-01: Withdrawal Approval Preserves Audit Evidence

1. Log in as `admin@oceangrill.com`.
2. Trigger or locate a staff withdrawal request.
3. Approve the request.
4. Open audit logs or the task assignment history area.

Expected:
- The assignment is marked `withdrawn`, not deleted.
- The withdrawal reason remains available.
- The review decision is recorded as approved.
- The reviewer and review time are recorded.
- If the staff had clocked in, clock-in and clock-out evidence remains available.

## Manager

### MG-P2-01: Approve Withdrawal Before Clock-In

Precondition:
- A staff member has requested withdrawal from an assigned task before clocking in.

Steps:
1. Log in as `sarah@oceangrill.com`.
2. Open the pending withdrawal request.
3. Approve the request.

Expected:
- Assignment status becomes `withdrawn`.
- The assignment row remains in history.
- The withdrawal reason, request time, reviewer, review time, and decision are saved.
- The task no longer counts that staff member as occupying a slot.

### MG-P2-02: Approve Withdrawal After Clock-In

Precondition:
- A staff member has clocked in and then requested withdrawal.

Steps:
1. Log in as `sarah@oceangrill.com`.
2. Approve the withdrawal request.

Expected:
- Assignment status becomes `withdrawn`.
- The original clock-in time is preserved.
- A clock-out time is recorded to close the partial worked interval.
- The task no longer counts that staff member as occupying a slot.

### MG-P2-03: Deny Withdrawal Before Clock-In

Precondition:
- A staff member has requested withdrawal from an assigned task before clocking in.

Steps:
1. Log in as `sarah@oceangrill.com`.
2. Deny the withdrawal request.

Expected:
- Assignment status returns to `assigned`.
- Review decision is recorded as denied.
- Reviewer and review time are saved.
- The staff member still sees the task as active work.

### MG-P2-04: Deny Withdrawal After Clock-In

Precondition:
- A staff member has clocked in and then requested withdrawal.

Steps:
1. Log in as `sarah@oceangrill.com`.
2. Deny the withdrawal request.

Expected:
- Assignment status returns to `in_progress`.
- Existing clock-in time is preserved.
- No clock-out time is created by the denial.
- The staff member can continue the active task.

## Staff

### ST-P2-01: Duplicate Withdrawal Request Is Blocked

1. Log in as `jamie@oceangrill.com`.
2. Submit a withdrawal request for an assigned task.
3. Try to submit another withdrawal request for the same task before manager review.

Expected:
- First request succeeds.
- Second unresolved request is blocked.
- Original reason and request time remain unchanged.

### ST-P2-02: Staff Sees Denied Request Restored To Correct State

1. Log in as a staff user.
2. Request withdrawal before clock-in or after clock-in.
3. Ask a manager to deny the request.
4. Return to My Tasks.

Expected:
- If the request was before clock-in, task appears as assigned.
- If the request was after clock-in, task appears as in progress.
- The task is not duplicated.

## System / API Smoke Checks

### SYS-P2-01: Approval Does Not Delete Assignment

Use an API client or Prisma Studio after approving a withdrawal.

Expected:
- `TaskAssignment` row still exists.
- `status = withdrawn`.
- `withdrawalDecision = approved`.
- `withdrawalReviewedById` is populated.
- `withdrawalReviewedAt` is populated.

### SYS-P2-02: Denial Restores Previous State

Use an API client or Prisma Studio after denying withdrawal.

Expected:
- `withdrawalDecision = denied`.
- `status` equals the stored `withdrawalStatusBeforeRequest`.
- `withdrawalReason` and `withdrawalRequestedAt` remain available for history.

---

# Phase 3: Replacement Allocation And Coverage Recovery

## Company Admin

### CA-P3-01: Approved Withdrawal Is Replaced Automatically

Precondition:
- A task requires one staff member.
- One staff member is assigned and has requested withdrawal.
- At least one other staff member is eligible.

Steps:
1. Log in as `admin@oceangrill.com`.
2. Open the task and approve the withdrawal request.
3. Review the task assignments and audit log.

Expected:
- The original assignment remains in history as `withdrawn`.
- Coverage is recalculated from current assignment records.
- The highest-ranked eligible replacement is immediately `assigned`.
- The replacement action appears in the audit log.
- No acceptance step is required from the replacement.

### CA-P3-02: Manager Removal Also Triggers Replacement

1. Open a fully staffed task with another eligible staff member available.
2. Remove one active staff assignment.
3. Refresh the task.

Expected:
- The removed assignment no longer occupies a slot.
- The system automatically assigns an eligible replacement.
- Required headcount is restored without a manual assignment step.

## Manager

### MG-P3-01: Existing Assignees Are Not Duplicated

Precondition:
- A task requires two staff members and currently has two active assignments.
- One staff member requests withdrawal.
- A third eligible staff member is available.

Steps:
1. Log in as `sarah@oceangrill.com`.
2. Approve the withdrawal request.
3. Review all active assignments on the task.

Expected:
- The withdrawn staff member is not selected again.
- The staff member who was already assigned is not duplicated.
- The third eligible staff member fills the released slot.
- Active assignment count equals required headcount.

### MG-P3-02: No Candidate Leaves A Visible Coverage Gap

Precondition:
- A task has a pending withdrawal request.
- All other staff are unavailable, inactive, conflicting, or otherwise ineligible.

Steps:
1. Approve the withdrawal request.
2. Refresh the task and dashboard.
3. Open notifications.

Expected:
- The withdrawal is still approved.
- No ineligible replacement is created.
- The task remains partially filled or unassigned based on its headcount.
- A `Replacement needed - no eligible staff` notification identifies the remaining gap.

### MG-P3-03: Manager Can Fill An Unresolved Gap Manually

1. Start from the unfilled task in MG-P3-02.
2. Make a staff member eligible or add a newly eligible staff member.
3. Use the existing manual assignment control.

Expected:
- Manual candidate selection remains available.
- The selected eligible staff member is assigned immediately.
- Coverage returns to the required headcount.

## Staff

### ST-P3-01: Replacement Staff Receives Immediate Assignment

1. Log in as the staff member automatically selected as a replacement.
2. Open My Tasks and notifications.

Expected:
- The replacement task appears as `assigned`.
- A new assignment notification is present.
- There is no Accept or Reject action.
- Clock In and Request Withdrawal remain available at the correct time.

### ST-P3-02: Withdrawn Staff Is Not Immediately Reassigned

1. Log in as the staff member whose withdrawal was approved.
2. Open My Tasks after the manager approves the request.

Expected:
- The original assignment remains `withdrawn` in history.
- The same task is not added again as a new active assignment.
- The withdrawal-approved notification remains visible.

## System / API Smoke Checks

### SYS-P3-01: Coverage Uses Authoritative Assignment States

Inspect the task after automatic replacement.

Expected:
- Only `assigned`, `in_progress`, `clocked_out`, and `withdrawal_requested` rows occupy slots.
- `withdrawn`, `cancelled`, and `completed` rows do not occupy replacement slots.
- Active assignment count never exceeds `requiredHeadcount`.

### SYS-P3-02: Ranked Output Cannot Inject A Candidate

Run replacement allocation with a withdrawn member, an existing assignee, and an ineligible member in the organization.

Expected:
- Only membership IDs from the server-verified eligible candidate set can be assigned.
- Duplicate or unknown IDs returned by an AI provider are ignored.
- Existing and withdrawn membership IDs remain excluded from replacement selection.

---

# Phase 4 - Final Eligibility And Atomic Assignment

## Company Admin

### CA-P4-01: Candidate Lists Contain Staff Members Only

1. Open a task that has active Staff, Manager, Company Admin, Platform Admin, and inactive memberships available in the organization.
2. Open the manual assignment candidate list and generate an automatic allocation suggestion.

Expected:
- Only active Staff memberships appear as assignable candidates.
- Managers, Company Admins, Platform Admins, and inactive memberships are absent.

### CA-P4-02: A Mixed Batch Is Fully Rolled Back

1. Select one eligible Staff member and one Staff member who is unavailable, uncertified, conflicting, over the hour limit, or outside the task department.
2. Submit both members in one assignment request.
3. Refresh the task and inspect notifications.

Expected:
- The request is rejected with the ineligible member's reason.
- Neither member is assigned.
- No assignment notification is sent for the rejected batch.

## Manager

### MG-P4-01: Eligibility Is Rechecked At Confirmation

1. Open a task and leave its candidate list visible.
2. In another session, make the selected Staff member inactive, unavailable, conflicting, over-limit, uncertified, or remove them from the task department.
3. Return to the original session and confirm the assignment without refreshing.

Expected:
- The stale candidate decision is ignored.
- The assignment is rejected using current server-side data and shows the applicable reason.

### MG-P4-02: A Valid Documented Override Is Honored

1. Create an eligibility override for a supported warning such as a scheduling conflict.
2. Assign that Staff member to the task.
3. Repeat with a Manager, admin, inactive, cross-tenant, or wrong-department membership ID.

Expected:
- The documented eligibility override permits the supported warning case.
- The strict role, account, tenant, and department restrictions cannot be bypassed.

### MG-P4-03: Concurrent Requests Cannot Overfill A Task

1. Prepare a task with exactly one remaining slot and two eligible Staff members.
2. Submit both assignment requests at nearly the same time from separate sessions.
3. Refresh the task.

Expected:
- Exactly one request claims the final slot.
- The other request fails because the task is fully staffed.
- Active assignments never exceed required headcount.

## Staff

### ST-P4-01: Only Committed Assignments Reach Staff

1. Complete one valid assignment batch and one rejected mixed batch that includes this Staff member.
2. Log in as the Staff member and inspect My Tasks and notifications.

Expected:
- The successfully committed assignment appears immediately with its notification.
- No task or notification from the rejected batch appears.

## System / API Smoke Checks

### SYS-P4-01: Auto-Schedule Drafts Pass The Final Gate

Confirm a stale or tampered auto-schedule payload containing a Manager, an inactive member, or a membership ID from another organization.

Expected:
- Server-side task and membership records are authoritative.
- The invalid draft is rejected and creates no assignment for that task batch.

### SYS-P4-02: Duplicate Batch Writes Are Atomic

Submit the same eligible membership ID twice in one assignment batch.

Expected:
- The complete batch is rejected.
- Zero assignment rows and zero assignment notifications are created.

### SYS-P4-03: Auto-Schedule Candidate Collection Is Staff-Only

Generate an auto-schedule while the organization contains active Managers, admins, Platform Admin users, inactive Staff, and active Staff.

Expected:
- Only active, non-platform Staff memberships are considered.
- Every confirmed task group uses the same final eligibility and atomic headcount checks as manual assignment.

---

# Phase 5 - Secure Auto-Schedule Confirmation

## Company Admin

### CA-P5-01: Confirm A Valid Generated Schedule

1. Generate a weekly auto-schedule containing assignments for multiple tasks.
2. Review the draft and select Confirm Schedule.
3. Open the affected tasks, notifications, and audit log.

Expected:
- Every confirmed assignment becomes active immediately.
- Staff names and task titles shown afterward come from current server records.
- Assignment notifications are created only after the complete schedule commits.
- One auto-schedule audit event records trusted task and membership IDs.

### CA-P5-02: A Stale Task Rejects The Whole Schedule

1. Generate a draft containing at least two tasks.
2. In another session, cancel or complete one task before confirming the draft.
3. Confirm the original draft.

Expected:
- Confirmation is rejected because the stale task is no longer open.
- No assignment from any task in that confirmation is created.
- No Staff member receives an assignment notification.

### CA-P5-03: Filled Headcount Rejects A Stale Draft

1. Generate a draft for a task with one remaining slot.
2. Fill that slot from another session.
3. Confirm the original draft.

Expected:
- Confirmation fails with a headcount conflict.
- Required headcount is not exceeded.
- Other assignments submitted in the same confirmation are rolled back.

## Manager

### MG-P5-01: Manager Cannot Confirm An Organization-Wide Schedule

1. Log in as a Manager.
2. Send a confirmation request directly to the auto-schedule confirmation API.

Expected:
- The request returns `403 Forbidden` because the current weekly auto-schedule is Company Admin-only.
- No assignment, notification, or audit event is created.

## Staff

### ST-P5-01: Staff Sees Only Fully Committed Schedule Results

1. Log in as a Staff member included in a successful confirmation.
2. Check My Tasks and notifications.
3. Repeat after a Company Admin submits a confirmation containing one invalid reference.

Expected:
- The successful schedule appears immediately with a server-generated notification.
- The rejected schedule creates no task or notification for any included Staff member.

## System / API Smoke Checks

### SYS-P5-01: Reject Display And AI Fields At The Boundary

Submit a confirmation item containing valid IDs plus `taskTitle`, `staffName`, `reasoning`, or `score`.

Expected:
- The API returns `400 Validation failed`.
- The confirmation service is not called.
- The accepted request shape contains only `taskId` and `membershipId`.

### SYS-P5-02: Reject Cross-Tenant Identifiers Atomically

Submit a valid local assignment together with either a task ID or membership ID from another organization.

Expected:
- The foreign task is treated as not found and the foreign member as invalid.
- Zero assignments and zero notifications are created across the complete request.
- The response does not expose records from the other organization.

### SYS-P5-03: Reject Cross-Draft Schedule Conflicts

Submit the same Staff member for two overlapping tasks in one confirmation.

Expected:
- The complete schedule is rejected before writing assignments.
- Neither overlapping assignment is created.

### SYS-P5-04: Reject Duplicate Assignment Pairs

Submit the same `taskId` and `membershipId` pair twice.

Expected:
- Zod rejects the request as a duplicate pair.
- No assignment, notification, or audit event is created.

---

# Phase 6 - Employment Types And Availability Policy

## Company Admin

### CA-P6-01: Invite And Edit Canonical Employment Types

1. Invite one Staff member as Casual and another as Temporary or Part-Time.
2. Accept both invitations, then edit each Staff member's employment type.
3. Inspect the member list and filters.

Expected:
- Staff forms offer only Casual and Temporary or Part-Time.
- Saved values and filters show the selected canonical labels.
- Manager and Company Admin memberships do not receive a Staff employment type.

### CA-P6-02: Import Employment Type Aliases

1. Download the member import template and inspect its employment-type examples.
2. Import Staff rows containing `casual`, `part-time`, `temporary`, and legacy `full_time` values.
3. Open the imported members.

Expected:
- The template documents Casual and Temporary or Part-Time.
- Part-time and temporary aliases become Temporary or Part-Time.
- Legacy `full_time` becomes Casual.
- Unsupported values are reported instead of being silently stored.

## Manager

### MG-P6-01: Availability Applies By Employment Type

1. Create a scheduled task with two otherwise eligible Staff members: one Casual and one Temporary or Part-Time.
2. Leave both without matching weekly availability and inspect task eligibility.
3. Add matching availability for the Temporary or Part-Time Staff member and inspect eligibility again.

Expected:
- Casual remains eligible without weekly availability, subject to all other rules.
- Temporary or Part-Time is initially ineligible with a clear availability reason.
- Temporary or Part-Time becomes eligible after matching availability is saved.

### MG-P6-02: Auto-Schedule Uses The Same Policy

1. Generate a weekly auto-schedule containing the two Staff members from MG-P6-01.
2. Compare the draft before and after adding Temporary or Part-Time availability.

Expected:
- The draft can consider Casual without a weekly availability record.
- Temporary or Part-Time is excluded until the task fits saved availability.
- Confirming the draft rechecks the same policy server-side.

## Staff

### ST-P6-01: Temporary Or Part-Time Availability Controls Assignment

1. Log in as Temporary or Part-Time Staff and save weekday availability.
2. Ask a Manager to assign one task inside that window and one outside it.
3. Check My Tasks and notifications.

Expected:
- The task inside availability can be assigned when all other rules pass.
- The task outside availability is rejected.
- Only committed assignments appear in My Tasks and notifications.

### ST-P6-02: Casual Does Not Require Weekly Availability

1. Log in as Casual Staff with no weekly availability saved.
2. Ask a Manager to assign a non-conflicting task for which all other requirements pass.

Expected:
- Missing weekly availability alone does not block the assignment.
- Department, certification, conflict, hours, work-rule, and account checks still apply.

## System / API Smoke Checks

### SYS-P6-01: Reject Obsolete Canonical Input

Submit invitation, member update, and import API payloads using `full_time` directly where canonical API input is required.

Expected:
- Validation accepts only `casual` or `temporary_part_time` for canonical API requests.
- No obsolete employment type is written by normal application workflows.

### SYS-P6-02: Migrate Legacy Stored Values

Apply `20260801010000_align_employment_types` to a database containing `full_time` Membership and InvitationToken rows.

Expected:
- Both tables map `full_time` to `casual` without deleting records.
- Existing Staff and pending invitation relationships remain intact.

### SYS-P6-03: Legacy Reads Remain Safe Before Migration

Read an existing Staff membership or invitation that still contains `full_time` before the migration is deployed.

Expected:
- Application behavior and displayed labels normalize the value to Casual.
- Eligibility does not accidentally impose Temporary or Part-Time availability rules.

---

# Phase 7 - Task Location And Instructions

## Company Admin

### CA-P7-01: Create A Complete Task

1. Log in as `admin@oceangrill.com` and open Tasks.
2. Create a task with department, schedule, headcount, certification requirements, location, and instructions.
3. Open the created task.

Expected:
- The task is created and its detail view shows the saved location and instructions.
- Existing scheduling, requirements, and automatic-allocation behavior still applies.

### CA-P7-02: Edit Or Clear Details Without Changing Schedule

1. Edit only the location and instructions of a scheduled task.
2. Save, reopen the task, and compare its schedule with the original values.
3. Edit again, clear both fields, and save.

Expected:
- Detail changes persist while the original start and end times remain unchanged.
- Clearing the optional fields removes them without affecting other task data.

## Manager

### MG-P7-01: AI Prefills Dedicated Task Details

1. Log in as `sarah@oceangrill.com` and open Tasks.
2. Enter `Prepare stock at Loading Dock. Instructions: use the west entrance` in the natural-language task input.
3. Generate the task draft, review the form, complete any required fields, and create it.

Expected:
- Location is prefilled as `Loading Dock` and instructions as `use the west entrance`.
- The Manager can review or change both values before creation.
- The created task shows both values separately from its description.

### MG-P7-02: Recurring Tasks Inherit Details

1. Create a recurring task with a location, instructions, and certification requirement.
2. Generate upcoming occurrences and open one generated task.

Expected:
- Each occurrence inherits the parent location, instructions, and certification requirement.
- Its occurrence-specific schedule remains correct.

## Staff

### ST-P7-01: View Work Details In My Tasks

1. Log in as a Staff member assigned to the task from CA-P7-01 or MG-P7-01.
2. Open My Tasks and inspect the assignment.

Expected:
- The assigned task shows its location and instructions before the Staff member starts work.
- Clock-in, clock-out, completion, and withdrawal actions remain available according to assignment state.

### ST-P7-02: View Details On A Recurring Assignment

1. Assign the Staff member to an occurrence generated in MG-P7-02.
2. Open that occurrence in My Tasks.

Expected:
- The occurrence displays the inherited location and instructions.
- The Staff member sees only committed assignments they are authorized to view.

## System / API Smoke Checks

### SYS-P7-01: Enforce Detail Length Limits

Submit task create and update requests with a location longer than 200 characters or instructions longer than 4,000 characters.

Expected:
- Validation rejects each oversized field and no invalid data is persisted.

### SYS-P7-02: Preserve Omitted Fields On Partial Update

Patch only `location` or `instructions` on an existing scheduled task without sending `startTime` or `endTime`.

Expected:
- The requested field changes and omitted schedule fields retain their existing values.

### SYS-P7-03: Migrate Existing Tasks Safely

Apply `20260801030000_add_task_details` to a database containing existing tasks.

Expected:
- The migration adds nullable `location` and `instructions` columns without deleting or invalidating existing tasks.
- Prisma reports the database schema as up to date.

---

# Phase 8 - Certification Definitions And Scoped Review

## Company Admin

### CA-P8-01: Manage The Certification Catalogue

1. Log in as `admin@oceangrill.com` and open Certifications.
2. Create a certification definition with a description.
3. Assign it to Kitchen as Required and Bar as Optional.
4. Edit its name or assignments, deactivate it, reactivate it, then delete it.

Expected:
- Company Admin can create, update, activate, deactivate, and delete definitions.
- Department assignments and required status persist after reopening the page.
- Duplicate names, including case-only duplicates, are rejected.
- Historical Staff certification submissions remain after a definition is deleted.

### CA-P8-02: Review Across The Organization

1. Review pending certification submissions from Kitchen and Bar Staff.
2. Verify one and reject another with a reason.

Expected:
- Company Admin can review submissions across all departments.
- Each decision updates eligibility, creates an audit event, and notifies the Staff member.

## Manager

### MG-P8-01: View Definitions Without Mutating Them

1. Log in as `sarah@oceangrill.com` and open Certifications.
2. Inspect the certification catalogue and attempt create, update, or delete requests through the API.

Expected:
- The catalogue and department requirements are visible without management buttons.
- Every mutation request returns `403 Forbidden`.

### MG-P8-02: Review Only Assigned Departments

1. As Sarah, compare pending Kitchen and Bar certification submissions.
2. Try to verify or reject one submission from each department.

Expected:
- Kitchen submissions are listed and can be reviewed.
- Bar-only submissions are hidden and direct review requests return `404`.
- Company Admin remains able to review both.

### MG-P8-03: Required Definitions Populate Tasks

1. Open Tasks and start creating a task.
2. Select Kitchen as the department.
3. Inspect Required certifications, then create the task.

Expected:
- Food Safety Level 2 is selected automatically because it is required for Kitchen.
- Approved optional definitions can be selected manually.
- The created task uses the selected canonical certification names for eligibility.

## Staff

### ST-P8-01: Submit An Approved Certification

1. Log in as `alex@oceangrill.com` and open My Certifications.
2. Add a certification and inspect the certification-name control.
3. Select an active definition, enter evidence details, and submit it.

Expected:
- Active organization definitions appear as choices instead of requiring free typing.
- The submission uses the canonical definition name and starts Pending.
- A Manager must verify it before it satisfies task eligibility.

### ST-P8-02: Inactive Or Unknown Definitions Are Rejected

1. Have Company Admin deactivate a definition.
2. Refresh My Certifications and attempt to submit the inactive name or an unknown name through the API.

Expected:
- Inactive definitions disappear from the selector.
- The server rejects inactive and unknown names when the organization has a catalogue.
- Existing historical submissions remain visible.

## System / API Smoke Checks

### SYS-P8-01: Enforce Tenant Isolation

Use one organization to read, update, delete, or assign departments to another organization's definition.

Expected:
- Cross-tenant reads return no definition and mutations return `404` or validation failure.
- A department from another organization cannot be assigned to a definition.

### SYS-P8-02: Validate Definition Payloads

Submit duplicate department IDs, a name over 200 characters, a description over 2,000 characters, and an empty update.

Expected:
- Every invalid payload returns `400` and no partial definition or join rows are written.

### SYS-P8-03: Migrate Existing Certification Data Safely

Apply `20260801040000_add_certification_definitions` to a database containing existing Staff certifications and task requirements.

Expected:
- New catalogue tables are added without modifying historical certification submissions or task requirements.
- Prisma reports all 22 migrations applied and the schema up to date.

---

# Phase 9 - Enforced Custom-Role Permissions

## Company Admin

### CA-P9-01: Configure And Assign An Operational Role

1. Log in as `admin@oceangrill.com` and open Roles.
2. Create `Kitchen Dispatcher` with Departments: Read and Tasks: Create, Read, Update, and Assign.
3. Assign the role to `alex@oceangrill.com` from Members.
4. Reopen the member and role records.

Expected:
- The custom role and selected grants persist.
- Alex's sidebar shows the newly permitted operational pages after the next request or sign-in.
- No unrelated administration pages appear.

### CA-P9-02: Company Admin Remains Unrestricted

1. As Company Admin, open Members, Roles, Settings, Work Rules, Auto-Schedule, Audit Log, Tasks, and Certifications.
2. Perform one valid read or mutation in each area.

Expected:
- Company Admin retains every supported permission.
- Custom-role enforcement does not restrict the Company Admin system role.

## Manager

### MG-P9-01: Review Certifications Without Task Management

1. As Company Admin, create `Certification Reviewer` with Certifications: Read and Review only, then assign it to `sarah@oceangrill.com`.
2. Log in as Sarah and review a pending Kitchen certification.
3. Try to create, update, assign, or auto-allocate a task.

Expected:
- Sarah can list and review certifications in her assigned department.
- Every ungranted task operation returns `403 Forbidden`.
- A direct request for a Bar-only certification remains hidden or returns `404` despite the review grant.

### MG-P9-02: Permission Revocation Takes Effect Immediately

1. Remove Certifications: Review from Sarah's assigned custom role.
2. Refresh Sarah's session and try another review without changing her Manager system role.

Expected:
- The review controls are no longer available after refresh.
- A direct review API request returns `403 Forbidden`.
- Certification reads continue only if Certifications: Read remains granted.

## Staff

### ST-P9-01: Granted Task Access Keeps Department Scope

1. Log in as Alex after CA-P9-01.
2. Open Tasks and create a valid Kitchen task.
3. Attempt the same operation with a Bar department ID through the API.

Expected:
- Alex can use explicitly granted task operations for Kitchen.
- The Bar request returns `403 Forbidden` and creates no task.
- The custom role does not change Alex's Staff system role or make Alex assignable outside normal rules.

### ST-P9-02: Personal Workflows Survive An Empty Custom Role

1. As Company Admin, create a custom role with no operational grants and assign it to Alex.
2. Log in as Alex and open My Tasks, My Availability, My Certifications, and Notifications.
3. Attempt to open the organization task list or members API directly.

Expected:
- Alex can still access and act on owned records when lifecycle rules allow it.
- Operational routes without an explicit grant return `403 Forbidden`.
- No other member's records become accessible.

## System / API Smoke Checks

### SYS-P9-01: Deny And Grant Every Permission Boundary

For representative GET, POST, PATCH, and DELETE routes, call each route first with an empty custom role and then with its declared permission assigned.

Expected:
- The empty role receives `403` before business validation.
- The granted role passes the permission gate and proceeds to validation, subscription, scope, or service handling.

### SYS-P9-02: Preserve Tenant, Scope, And Ownership Boundaries

Use a fully granted custom role to request another organization's data, an out-of-department task or certification, and another member's personal record.

Expected:
- Cross-tenant membership checks still return `403`.
- Out-of-department records remain forbidden or not found.
- Personal actions still require ownership.

### SYS-P9-03: Seed The Complete Permission Catalogue

Run `npx prisma db seed`, open Roles, and inspect the permission groups.

Expected:
- Work rules, certifications, schedule generation, and billing permissions are available alongside the earlier permission keys.
- Re-running the seed creates no duplicate permission rows.

---

# Phase 10 - Configurable Ranking Priorities

## Company Admin

### CA-P10-01: Save And Normalize Ranking Priorities

1. Log in as `admin@oceangrill.com` and open Settings.
2. Under Task Configuration, set all four Ranking Priorities to `10`.
3. Save the configuration and reload the page.

Expected:
- The save succeeds and each factor is displayed as `25%`.
- The displayed total is `100%` after normalization.
- Allocation mode and unrelated settings remain unchanged.

### CA-P10-02: Change The Recommended Order

1. Prepare two eligible Kitchen Staff candidates: one with fewer worked hours and one with substantially more Kitchen history.
2. Set Workload balance to `100` and every other factor to `0`, then request suggestions for a Kitchen task.
3. Set Department experience to `100` and every other factor to `0`, then request the suggestions again.

Expected:
- The lower-workload candidate ranks first in the first result.
- The experienced candidate ranks first in the second result.
- Explanations mention only the factor with a non-zero priority.

## Manager

### MG-P10-01: Use Organization Priorities In Manual Ranking

1. Log in as `sarah@oceangrill.com` and open a Kitchen task.
2. View the ranked eligible candidates after CA-P10-02.

Expected:
- Candidate order reflects the priorities last saved by Company Admin.
- Ranking explanations show the active factor percentages and candidate factor scores.
- Sarah still sees only Staff candidates within her department scope.

### MG-P10-02: Use The Same Priorities For Automatic Allocation

1. Have Company Admin enable automatic allocation and save a clear single-factor priority.
2. As Sarah, create a valid Kitchen task requiring one person.

Expected:
- The highest-ranked eligible candidate is assigned immediately.
- Automatic allocation and manual suggestions use the same configured priorities.
- Final eligibility is rechecked before the assignment is committed.

## Staff

### ST-P10-01: Ranking Does Not Override Eligibility

1. Configure Department experience as `100%`.
2. Give one experienced Staff member a scheduling conflict, expired required certification, inactive membership, or out-of-department status.
3. Request suggestions or automatic allocation for the task.

Expected:
- The ineligible Staff member is absent regardless of experience.
- Only eligible Staff members can be ranked or assigned.
- Staff cannot change organization ranking priorities without the Settings update permission.

## System / API Smoke Checks

### SYS-P10-01: Validate Priority Payloads

Submit Settings updates containing a negative value, a value above `100`, a decimal value, an unknown shape, and four zero values.

Expected:
- Every invalid payload returns `400` and leaves the stored priorities unchanged.
- Any valid positive combination is normalized to a total of `100`.

### SYS-P10-02: Preserve Weighted Failover

Request rankings with no AI keys, with each provider unavailable, and with malformed provider JSON.

Expected:
- Every failure path returns the weighted deterministic order.
- The deterministic explanations use the organization's current priorities.
- Unknown or duplicate membership IDs from AI output never reach assignment.

### SYS-P10-03: Recover From Legacy Configuration

Set `smartAllocationWeights` to null or malformed JSON in a disposable test record, then fetch Settings and request suggestions.

Expected:
- Settings returns the default `30/25/25/20` priorities.
- Ranking completes without a server error.

---

# Phase 11 - AI Operations Assistant

## Company Admin

### CA-P11-01: Run An Organization Operations Analysis

1. Log in as `admin@oceangrill.com` and open Dashboard.
2. In AI Operations Assistant, enter `Analyze organization operations`.
3. Open one of the returned action links.

Expected:
- The assistant summarizes real coverage, staffing, or certification signals.
- Each suggested action opens the correct organization page.
- The request is recorded in the audit log as an AI operation.

### CA-P11-02: Check Onboarding Readiness

1. In the same assistant, enter `Check onboarding readiness`.
2. Review the returned recommended actions.

Expected:
- The assistant returns organization-specific setup or staffing recommendations.
- It does not create departments, change roles, or alter company policy automatically.

## Manager

### MG-P11-01: Create And Allocate A Task From The Dashboard

1. Log in as `priya@northstarit.com` with password `TestPass1!`.
2. Open Dashboard.
3. Enter `I need 2 Product Engineering staff tomorrow morning for the Atlas API release`.

Expected:
- The assistant creates the task and applies the department's required certifications.
- Eligible staff are allocated automatically when available.
- The result names the allocated staff and links to Tasks.

### MG-P11-02: Automatically Resolve Coverage Gaps

1. Create or leave an open understaffed task in one of Priya's departments.
2. In the dashboard assistant, enter `Resolve coverage gaps`.
3. Open Tasks.

Expected:
- The assistant checks only Product Engineering and Client Delivery tasks.
- It allocates eligible replacement staff without opening a manual picker.
- Any remaining gap is clearly reported with a Tasks link.

### MG-P11-03: Automatically Schedule The Manager's Departments

1. Create open scheduled tasks for the current week in Product Engineering and Client Delivery.
2. Also create an open scheduled Cloud & DevOps task.
3. Enter `Schedule my team this week` as Priya.
4. Open Calendar and Tasks.

Expected:
- Eligible assignments are created for Priya's departments.
- The Cloud & DevOps task is not included or changed.
- Staff receive assignment notifications.

### MG-P11-04: Create A Project-Style Work Plan

1. Enter `Create tasks for the Atlas CRM project in Product Engineering`.
2. Open Tasks and filter Product Engineering.

Expected:
- The assistant creates Plan, Deliver, and Review work stages.
- Each stage remains an ordinary task, so current allocation, audit, and notification logic applies.

## Staff

### ST-P11-01: Get A Daily Work Brief

1. Log in as a Northstar staff account with an assigned task.
2. Open Dashboard.
3. Enter `What do I need to do today?`.

Expected:
- Only that staff member's assigned work appears.
- The assistant provides a link to My Tasks.

### ST-P11-02: Check Conflicts And Certification Expiry

1. Enter `Check my schedule conflicts`.
2. Enter `Which certifications are expiring?`.

Expected:
- Schedule results only inspect the logged-in staff member's work.
- Certification results show only that staff member's records and link to My Certifications.
- No staff member can review or verify their own certification from the assistant.

---

# Phase 12 - Assistant UX And Operational Clarity

## Company Admin

### CA-P12-01: Understand The Operations Result

1. Log in as `admin@oceangrill.com` and open Dashboard.
2. Ask ShiftHappens to `Analyze organization operations`.
3. Review the result and open `What ShiftHappens checked`.

Expected:
- The result explains the organisation signals it checked before showing recommended actions.
- Recommendations remain informational; company configuration is not changed without an explicit admin action.

## Manager

### MG-P12-01: Create Work From The Shared Assistant

1. Log in as `priya@northstarit.com` with password `TestPass1!`.
2. Open Tasks and confirm the command area is headed `Ask ShiftHappens`.
3. Enter `I need 2 staff tomorrow morning for the Atlas API release in Product Engineering`.
4. Review the result, the created task, and the `What ShiftHappens checked` disclosure.

Expected:
- The same assistant experience appears on Dashboard and Tasks; there is no second command-bar workflow to learn.
- The task is created and eligible staff are allocated when possible.
- The result states the applied checks and provides an `Undo this action` control.

### MG-P12-02: Continue An Ambiguous Request Without Retyping

1. In Tasks, enter `I need one staff member tomorrow morning for preparation`.
2. When ShiftHappens asks for a department, select one of the department buttons.

Expected:
- The assistant immediately retries the original request with the selected department.
- The Manager does not need to edit, copy, or re-enter the request.

### MG-P12-03: Verify An Automatic Schedule Before And After Undo

1. Create open scheduled tasks in Priya's Product Engineering or Client Delivery departments.
2. Ask ShiftHappens to `Schedule my team this week`.
3. Review the named task-to-staff assignments in the receipt.
4. Select `Undo this action`, then open Calendar.

Expected:
- The receipt names the assignments it published and lists the eligibility checks performed.
- Undo removes only the assignments made by that assistant action.
- The Tasks page no longer issues a forbidden request to the company Settings endpoint for a Manager.

## Staff

### ST-P12-01: Receive A Personal, Explainable Brief

1. Log in as a staff account with an assigned task and open Dashboard.
2. Ask ShiftHappens `What do I need to do today?`.
3. Expand `What ShiftHappens checked`, then open My Tasks from the result.

Expected:
- The answer contains only the logged-in staff member's assignments.
- The assistant shows which schedule and conflict information it checked.
- My Tasks shows the task description, location, instructions, timing, and current work state.

---

# Phase 13 - Projects And Multi-Day Calendar

## Manager

### MG-P13-01: Create A Multi-Day Project

1. Log in as `priya@northstarit.com` with password `TestPass1!`.
2. Open Projects and create `Atlas API release` in Product Engineering.
3. Set a start date and end date at least three days apart.
4. Add a work item with a multi-day start and end time.

Expected:
- The project has its own timeframe and status instead of preset Plan, Deliver, and Review tasks.
- The work item is visibly linked to the project and uses normal automatic allocation.

### MG-P13-02: Review A Task From Calendar

1. Open Calendar and select the multi-day work item on each day it spans.
2. Review the task drawer.

Expected:
- The task appears on every day it overlaps, without overflowing the day grid.
- Selecting it opens a visible drawer with description, instructions, location, staffing, certifications, and project context.
- The calendar loads the organisation's configured operating hours without a Settings permission error for a Manager.

---

# Phase 14 - Unified Operations Experience

## Manager

### MG-P14-01: Generate A Schedule Draft From The Assistant

1. Log in as `priya@northstarit.com` with password `TestPass1!`.
2. Open Dashboard or Tasks.
3. Enter `Schedule my team this week` in Ask ShiftHappens.
4. Select `Review schedule` from the receipt.
5. Generate the schedule and review the suggested assignments.
6. Confirm the schedule only after reviewing it.

Expected:
- The assistant creates a reviewable draft and does not publish assignments immediately.
- The receipt names the workforce checks performed and directs the manager to Schedule Review.
- Publishing remains an explicit manager decision.

### MG-P14-02: Confirm Visible Department Scope

1. Open Dashboard and Tasks as a manager assigned to multiple departments.
2. Review the `Managing:` text below the heading.
3. Use the department filter on Tasks.

Expected:
- Every department the manager is authorised to manage is named.
- Tasks and assistant actions remain limited to that scope.

### MG-P14-03: Review Recent Assistant Work

1. Complete an assistant request.
2. Refresh the page or navigate away and back.
3. Expand `Recent operations` in Ask ShiftHappens.

Expected:
- The recent request and its result title remain visible for the signed-in user.
- Another user cannot see this manager's assistant history.

## Staff

### ST-P14-01: Reuse Weekly Availability

1. Log in as a staff user and open My Availability.
2. Set Monday to an available time range.
3. Select `Copy Monday to weekdays`, review the weekday rows, then save.
4. Select `Mark whole week unavailable`, review the rows, then save.

Expected:
- The bulk actions update the editable schedule before it is saved.
- Saving persists the chosen weekly availability.

### ST-P14-02: Edit And Remove A Date Override

1. Add an unavailable date override with a reason.
2. Select `Edit`, change it to available or update the reason, then save.
3. Select `Remove`.

Expected:
- The edited override retains the same date-specific record and displays its updated details.
- Remove deletes only the signed-in staff member's override.

---

# Phase 15 - Governance, Visibility, And Product Value

## Company Admin

### CA-P15-01: Review Settings Impact Before Saving

1. Log in as `admin@oceangrill.com`.
2. Open Settings and change an allocation or notification configuration.
3. Select the relevant save action.
4. Review the impact confirmation before choosing to continue or cancel.

Expected:
- The confirmation names the active staff, open tasks, and future assignments that could be affected.
- Cancelling leaves the existing configuration unchanged.
- Continuing saves the configuration and records a settings audit entry.

### CA-P15-02: Investigate Operations History

1. Open Audit Log.
2. Search for `AI operation`, a user name, or an action.
3. Apply a start and end date, then filter the entity type to AI operations.

Expected:
- Search, date, action, and entity filters can be combined.
- AI operations display the original request in readable form.
- Project and settings events use readable event names rather than raw internal codes.

## Public Visitor

### PV-P15-01: Understand The Product Outcome

1. Open the public landing page while signed out.
2. Review the first viewport and the operations receipt examples.

Expected:
- The page describes ShiftHappens as autonomous workforce operations.
- The core story is request -> workforce checks -> coordinated action -> review only when judgment is needed.

---

# Final UAT - One-Pass End-to-End Flow

Use only this section for the final demonstration. It follows one piece of work from company setup to staff completion. All listed demo accounts use `TestPass1!`.

## Before You Start

1. Open `http://localhost:3000` and confirm Tasks loads without an internal-server-error banner.
2. Use a future date/time for the task below when `tomorrow` would fall outside a staff member's saved availability.
3. Keep the task title easy to recognise, for example `Final UAT kitchen prep`.

## 1. Company Admin - Prepare The Company

1. Log in as `admin@oceangrill.com`.
2. Open Departments and confirm `Kitchen` exists.
3. Open Members and confirm `sarah@oceangrill.com` is an active Kitchen Manager and `alex@oceangrill.com` is an active Kitchen Staff member.
4. Open Certification Definitions and confirm `Food Safety Level 2` is required for Kitchen work, if you want to test certification filtering.
5. Open Settings, ensure automatic allocation is enabled, make a harmless notification-preference change, and select Save.
6. Read the impact confirmation. Select Cancel once, then repeat and select Continue.
7. Open Audit Log and confirm a readable `Settings updated` entry appears.

Pass condition: company setup is visible, the impact preview appears before saving, and the audit entry records the save.

## 2. Staff - Set Availability And Submit Certification

1. Log out and log in as `alex@oceangrill.com`.
2. Open My Availability. Set the working weekday for the planned task to available, select `Copy Monday to weekdays` if useful, and save.
3. Add a date override only if the planned task is outside the normal hours. Edit it once, then save it.
4. Open My Certifications and submit `Food Safety Level 2` if it is required and not already verified.
5. Open Dashboard and ask `What do I need to do today?`.

Pass condition: availability saves, the override can be edited, certification submission is visible, and the assistant returns only Alex's work information.

## 3. Manager - Verify Certification And Ask For Work

1. Log out and log in as `sarah@oceangrill.com`.
2. Open Dashboard and confirm `Managing: Kitchen` is visible.
3. Open Certifications. Verify Alex's pending certification, or reject it with a reason to test the exception path.
4. Open Tasks. In Ask ShiftHappens, enter: `I need 1 Kitchen staff tomorrow morning for Final UAT kitchen prep. Food Safety Level 2 required.`
5. If prompted for a department, select `Kitchen`. Otherwise, review the completed receipt.
6. Confirm the receipt lists its workforce checks. Open the created task and verify its department, schedule, headcount, certification requirement, and assigned staff.
7. Open Calendar, select `Final UAT kitchen prep`, and verify the details drawer shows task, staffing, certification, location/instructions, and schedule information.

Optional schedule automation check:

8. In Ask ShiftHappens, enter `Schedule my Kitchen team this week`.
9. Confirm the result says `Schedule draft ready`, then select `Review schedule`.
10. Generate the draft, review any exceptions, and use `Confirm schedule` only if you want the draft assignments published.

Pass condition: the Manager operates only in Kitchen, the assistant creates/reviews work from a sentence, scheduling creates a draft before publishing, and Calendar opens task details directly.

## 4. Staff - Perform The Assigned Work

1. Log out and log in again as `alex@oceangrill.com`.
2. Open My Tasks and find `Final UAT kitchen prep`.
3. Open My Calendar and confirm the same assigned work appears with its date, time, department, location, and state.
4. Return to My Tasks and verify the task details are correct.
5. Optional exception test: request withdrawal before clock-in. Log in as Sarah to approve or deny it, then return to Alex.
6. Clock in, confirm the task becomes `in_progress`, then clock out.
7. Complete the assignment and confirm it appears under Completed for both Alex and the Manager.
8. Open Notifications and confirm the assignment and any withdrawal/certification messages are present.

Pass condition: the staff member sees only personal work, can progress the work lifecycle, and cannot manage another person's task, availability, or certification.

## 5. Company Admin - Confirm The Outcome

1. Log out and log in as `admin@oceangrill.com`.
2. Open Dashboard, Tasks, Calendar, and Audit Log.
3. Confirm the completed task is visible organisation-wide and its assignment/work state is correct.
4. In Audit Log, search for `Final UAT` or filter the relevant task/AI operations.
5. Open the public landing page in a signed-out tab and confirm the first section explains request -> checks -> coordinated action -> review.

Pass condition: the Admin sees the operational result and history without having manually allocated the staff member.

## 6. Manager - Create And Coordinate A Project

1. Log in as `priya@northstarit.com` with password `TestPass1!`.
2. Open Projects and create `Atlas API release` in Product Engineering with a start date and end date at least three days apart.
3. Create a linked task for the project, for example `Prepare API deployment checklist`, scheduled within the project date range.
4. Create one further project task scheduled on a different project day.
5. Open the project and confirm its tasks, status, dates, and department are visible together.
6. Open Calendar and select each project task.

Pass condition: the project is separate from individual tasks, the task dates can span multiple days, and Calendar opens the correct details for each project task.

## 7. Staff - Confirm Project Work Is Actionable

1. Log out and sign in as a Product Engineering staff member assigned to one of the project tasks.
2. Open My Calendar and My Tasks.
3. Open the assigned project task and confirm its title, schedule, department, and instructions.
4. Clock in, clock out, and complete the task when it is scheduled.

Pass condition: staff receive and complete project work through the same simple task lifecycle without needing project-management permissions.

## 8. Company Admin - Local Stripe Payment Check

Precondition: Stripe CLI is forwarding webhooks to `localhost:3000/api/stripe/webhook`, and the app is running locally.

1. Log in as the Company Admin for a Free-tier organization.
2. Open Settings, select `Upgrade to Pro`, and use Stripe test card `4242 4242 4242 4242` with any future expiry date and CVC.
3. Return to Settings and refresh after the Stripe CLI reports `checkout.session.completed`.
4. Confirm the plan shows Pro and `Manage billing` opens the Stripe Customer Portal.
5. In the portal, cancel the subscription. Return to Settings after the Stripe CLI reports `customer.subscription.deleted`.

Pass condition: only the verified webhook changes the plan, billing management stays Company Admin-only, and cancellation returns the organization to Free.

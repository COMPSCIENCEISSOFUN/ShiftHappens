# ShiftHappens Product Requirements Document

**Document status:** Repository source of truth  
**Version:** 2.0  
**Last updated:** 31 July 2026  
**Project:** ShiftHappens - Smart Task Allocation System  
**Repository:** `COMPSCIENCEISSOFUN/ShiftHappens`

> This PRD defines the final intended product workflow. It overrides older repository references to task acceptance, task rejection, unresponded assignments, and manual allocation as the default mode.

---

## 1. Purpose

ShiftHappens is a multi-tenant web application that helps organizations allocate casual, temporary, part-time, and other flexible Staff Members to operational tasks.

The system centralizes:

- organization onboarding and subscription plans;
- departments, members, roles, certifications, and workforce rules;
- task creation and required headcount;
- deterministic eligibility checking;
- explainable candidate ranking;
- automatic allocation by default;
- manual Manager assignment as an alternative;
- time recording and assignment completion;
- withdrawal requests and replacement allocation;
- notifications and audit logging.

The core product objective is to reduce repetitive Manager effort while preserving control, transparency, and rule enforcement.

---

## 2. Document Authority and Precedence

When product documents or code disagree, use this order of precedence:

1. This `PRD.md`.
2. Supervisor-approved Work Breakdown Structure and final report requirements.
3. Current approved use cases and final workflow diagrams.
4. Implementation documentation and tests.
5. Older PRD, PTD, README, seed data, comments, and UI text.

The following older concepts are obsolete and must not be reintroduced:

- Staff Member task acceptance;
- Staff Member task rejection;
- pending acceptance states;
- unresponded assignment reminders;
- `taskAcceptanceMode`;
- manual allocation as the default;
- AI being allowed to bypass eligibility rules.

---

## 3. Product Goals

### 3.1 Primary goals

1. Allocate suitable Staff Members to tasks using clear eligibility rules.
2. Use automatic allocation as the default workflow.
3. Keep manual Manager assignment available for contextual decisions.
4. Explain why candidates are eligible, warned, blocked, or ranked highly.
5. Prevent cross-organization and unauthorized department access.
6. Support urgent withdrawal before or during task execution.
7. Preserve worked-time evidence when a Staff Member withdraws after clock-in.
8. Maintain notifications and audit records for important actions.

### 3.2 Success criteria

The product is considered successful when the following end-to-end workflow works reliably:

1. A Company Admin creates or joins an organization.
2. Departments and Staff Members are configured.
3. A Manager creates a task with schedule, department, headcount, and requirements.
4. The system checks candidate eligibility.
5. The system ranks eligible candidates and explains its results.
6. Automatic allocation selects the highest-ranked eligible Staff Members by default.
7. Manual assignment remains possible using the same eligibility results.
8. Assignments become active immediately.
9. Staff Members can clock in, clock out, and complete their own assignments.
10. Staff Members can request withdrawal before starting or while work is in progress.
11. Managers can approve or deny withdrawal requests.
12. Approved withdrawals can trigger automatic or manual replacement allocation.
13. Relevant notifications and audit records are produced.

---

## 4. Non-Goals

The following are outside the required Final Year Project scope:

- payroll processing;
- leave management;
- recruitment and applicant tracking;
- employee benefits and performance appraisal;
- live production payment processing;
- taxes, refunds, proration, and failed-payment recovery;
- native iOS and Android applications;
- full business-intelligence reporting;
- two-way external calendar synchronization;
- enterprise HR, payroll, biometric, or identity-provider integrations;
- AI making final eligibility decisions.

---

## 5. Actors and Access Boundaries

### 5.1 Unregistered User

May access public content only, including product information, subscription plans, registration, email verification, privacy policy, terms, and contact information.

### 5.2 Platform Admin

May manage platform-level organization tenants and platform summaries. The Platform Admin does not normally participate in an organization's internal task-allocation workflow.

### 5.3 Company Admin

May manage organization-wide administration, including:

- organization profile;
- subscription information and limits;
- departments;
- members and invitations;
- roles and permitted custom permissions;
- certification definitions;
- workforce and allocation settings;
- notifications;
- audit logs.

The actor name remains **Company Admin**, but organization entities and descriptions use **organization**.

### 5.4 Manager

May manage operational records only within authorized departments, including:

- tasks;
- Staff Member records;
- eligibility and ranking results;
- automatic and manual allocation;
- certifications requiring review;
- withdrawal requests;
- replacement allocation;
- department calendars and notifications.

### 5.5 Staff Member

May access personal records and assignments, including:

- assigned tasks;
- task details and status;
- clock-in and clock-out;
- worked hours;
- assignment completion;
- withdrawal requests;
- certifications;
- personal calendar and history;
- notifications.

### 5.6 Staff types

The approved product distinguishes:

- **Casual Staff**;
- **Temporary or Part-Time Staff**.

Temporary or Part-Time Staff manage weekly availability. Availability for other Staff Member types is applied only when required by organization policy and supported by their workforce records.

---

## 6. Canonical Terminology

Use these terms consistently in code, UI, tests, comments, seed data, diagrams, and documentation.

| Canonical term | Meaning |
|---|---|
| Organization | A tenant using ShiftHappens |
| Company Admin | Organization-level administrator actor |
| Manager | Department-scoped operational user |
| Staff Member | Assignable workforce member |
| Task | Work requiring one or more Staff Members |
| Required headcount | Number of active Staff Member assignments needed |
| Eligibility check | Deterministic rule evaluation before ranking or assignment |
| Candidate ranking | Ordering eligible candidates using configured factors and optional AI assistance |
| Automatic allocation | Default process that selects the highest-ranked eligible candidates |
| Manual assignment | Manager-selected allocation using the same eligibility rules |
| Active assignment | Confirmed assignment that does not require Staff Member acceptance |
| Withdrawal request | Staff Member request to leave an assignment, with a mandatory reason |
| Replacement allocation | Allocation of another eligible Staff Member after approved withdrawal or removal |
| Warning | Non-blocking condition that may require authorized override |
| Block | Strict condition that prevents normal assignment |

Avoid these obsolete product terms:

- pending acceptance;
- accept assignment;
- reject assignment;
- rejection reason for an assignment;
- unresponded assignment;
- auto-accept;
- task acceptance mode.

Certification rejection remains valid because it refers to a Manager rejecting an invalid certification submission, not a Staff Member rejecting an assignment.

---

## 7. Canonical Workflow

### 7.1 Automatic allocation path

```text
Task creation
-> Eligibility checking
-> Candidate ranking
-> Automatic staff selection
-> Immediate active assignment
-> Task execution or withdrawal request
```

Automatic allocation is the default.

### 7.2 Manual assignment path

```text
Task creation
-> Eligibility checking
-> Ranked staff suggestions
-> Manager selection
-> Immediate active assignment
-> Task execution or withdrawal request
```

Manual assignment is an alternative, not a separate eligibility system.

### 7.3 Normal execution path

```text
Active assignment
-> Clock in
-> Clock out
-> Complete individual assignment
```

Completing one assignment must not automatically complete the assignments of other Staff Members on the same task.

### 7.4 Withdrawal before work starts

```text
Active assignment
-> Withdrawal request with reason
-> Manager review
-> Approval or denial
-> Replacement allocation where required
```

### 7.5 Withdrawal during task execution

A Staff Member who has already clocked in may still request withdrawal when an urgent reason prevents continued work.

```text
Clocked in / work in progress
-> Withdrawal request with reason
-> Stop current work session and preserve partial worked time
-> Manager review
-> Approval or denial
-> Replacement allocation where required
```

A withdrawal request does not immediately remove the Staff Member from the assignment. The request and assignment must be separate records or independently represented states.

---

## 8. Assignment and Work-Time State Model

### 8.1 Recommended assignment statuses

Use a small, explicit assignment lifecycle:

| Status | Meaning |
|---|---|
| `assigned` | Active assignment created; Staff Member has not started work |
| `in_progress` | Staff Member has at least one active work session |
| `completed` | Staff Member completed the individual assignment |
| `withdrawn` | Manager approved withdrawal |
| `cancelled` | Assignment ended because the task or assignment was administratively cancelled |

Do not use `pending`, `accepted`, or `rejected` as assignment lifecycle states.

### 8.2 Withdrawal request statuses

Use a separate withdrawal request lifecycle:

| Status | Meaning |
|---|---|
| `pending` | Request submitted and awaiting Manager decision |
| `approved` | Manager approved withdrawal |
| `denied` | Manager denied withdrawal |

A separate record is strongly recommended:

```text
WithdrawalRequest
- id
- assignmentId
- requestedByUserId
- reason
- assignmentStateAtRequest
- requestedAt
- reviewedByUserId
- decision
- decisionReason optional
- reviewedAt
```

### 8.3 Work sessions

To support partial work and possible multiple clock-in periods, use a separate work-session record rather than a single clock-in and clock-out pair stored directly on the assignment.

```text
WorkSession
- id
- assignmentId
- clockedInAt
- clockedOutAt optional
- stopReason optional: normal | withdrawal_request | manager_action | task_cancelled
- createdAt
- updatedAt
```

MVP rule for mid-task withdrawal:

1. A Staff Member may request withdrawal from `assigned` or `in_progress`.
2. If the assignment is `in_progress`, close the active work session at the withdrawal-request timestamp.
3. Preserve all completed work-session durations.
4. While the request is pending, prevent another clock-in unless the request is denied.
5. On approval, set the assignment to `withdrawn`.
6. On denial, return the assignment to `assigned`; the Staff Member may start a new work session.

This design avoids losing partial worked time and avoids corrupting the assignment state.

---

## 9. Task State Model

Recommended task states:

| Status | Meaning |
|---|---|
| `unallocated` | No active assignments |
| `partially_filled` | Active assignments are below required headcount |
| `filled` | Required headcount is met before task start |
| `active` | Task time has started or work is in progress |
| `completed` | Completion conditions are met |
| `cancelled` | Manager cancelled the task |

Task coverage must be calculated from current active assignment records, not trusted from a client-provided value.

---

## 10. Functional Requirements

### 10.1 Public access and onboarding

- Public users can view the landing page, features, benefits, pricing, privacy policy, terms, and contact information.
- Public users can select a plan.
- Paid-plan demonstrations use Stripe sandbox only.
- A user can register as the initial Company Admin.
- Email verification is required before account activation.
- The verified Company Admin can create an organization.
- The selected plan is associated with the organization.

### 10.2 Authentication and account management

- Invited Managers and Staff Members can accept an invitation and set a password.
- Authenticated users can log in, log out, reset a password, and update their profile.
- Users are routed to role-appropriate dashboards.
- Authentication alone is not authorization; every protected operation must apply server-side scope checks.

### 10.3 Platform administration

- Platform Admin can view organization tenants.
- Platform Admin can search and inspect permitted tenant information.
- Platform Admin can activate, deactivate, or restore tenants where authorized.
- Platform Admin cannot access normal organization task operations unless explicitly supported by a separate administrative function.

### 10.4 Organization administration

Company Admin can:

- view and update organization information;
- manage departments;
- invite, add, import, activate, and deactivate organization members;
- assign roles and departments;
- manage certification definitions;
- configure allocation and workforce rules;
- view subscription tier, limits, and usage;
- view organization notifications and audit records.

### 10.5 Subscription enforcement

- Plan limits must be enforced on the server.
- Active memberships and valid pending invitations count toward member limits.
- Invitation acceptance must recheck the limit to prevent race conditions.
- Plan usage must not be derived only from client state.
- Stripe remains in test mode.

### 10.6 Task management

Manager can:

- create a task within an authorized department;
- define title, description, department, date, start time, end time, location, priority, required headcount, required certifications, and instructions;
- view, search, and filter department tasks;
- update a task;
- cancel a task;
- create recurring tasks where implemented;
- view unallocated, partially filled, active, overdue, and completed tasks where supported.

### 10.7 Eligibility checking

The system must evaluate eligibility before ranking and again immediately before final assignment creation.

Required checks:

1. Candidate belongs to the same organization.
2. Candidate has an active membership.
3. Candidate is an assignable Staff Member, not a Company Admin or Manager account acting only in an administrative role.
4. Candidate belongs to the task department.
5. Candidate is available where availability applies.
6. Candidate has no blocked schedule overlap.
7. Candidate will not exceed applicable working-hour limits.
8. Candidate holds all required verified and unexpired certifications.
9. Candidate satisfies configured organization work rules.
10. Candidate has no duplicate active assignment for the task.

Each result must be explicit:

- `eligible`;
- `warning`;
- `blocked`.

Blocked conditions cannot be overridden through the normal workflow. Warning conditions may be overridden only by an authorized user and must record a reason.

### 10.8 Candidate ranking

- Rank only candidates who are eligible or have permitted warning-level results.
- Use configured ranking priorities when configuration is exposed in the product.
- Display ranking score or recommendation level where supported.
- Display human-readable recommendation reasons.
- Display ineligible Staff Members and reasons separately for transparency.
- AI may assist ranking and explanation generation.
- AI output must never change a blocked candidate to eligible.
- If AI providers fail or return invalid output, use a deterministic fallback algorithm.

### 10.9 Automatic allocation

- Automatic allocation is the default organization mode.
- Select highest-ranked eligible Staff Members.
- Attempt to fill required headcount.
- Never exceed required headcount through the normal workflow.
- Leave the task partially filled or unallocated if candidates are insufficient.
- Revalidate all final candidates immediately before creation.
- Create all selected assignments atomically.
- Assignments become `assigned` immediately.
- Generate notifications and audit records after successful commit.

### 10.10 Manual assignment

- Manager can open ranked suggestions.
- Manager can select one or more eligible Staff Members.
- The same final eligibility revalidation applies.
- Strict blocks cannot be bypassed.
- Warning overrides require permission and a reason.
- Selected assignments are created atomically and become active immediately.

### 10.11 Reassignment and removal

- Manager can remove or reassign Staff Members where authorized.
- The system recalculates coverage after removal or reassignment.
- Reassignment applies the same eligibility checks as initial allocation.
- Affected Staff Members receive relevant notifications.
- Important actions are audited.

### 10.12 Withdrawal requests

- A Staff Member can request withdrawal before clock-in or during execution.
- A reason is mandatory.
- The request does not immediately remove the Staff Member.
- A Manager can approve or deny the request.
- Approved withdrawal marks the assignment `withdrawn` and recalculates coverage.
- Denied withdrawal keeps or restores the assignment as active.
- Partial worked time is preserved if the request is submitted after clock-in.
- The Staff Member is notified of the decision.
- The decision is audited.

### 10.13 Replacement allocation

- Approved withdrawal creates a replacement need when coverage falls below headcount.
- Automatic replacement is the default option.
- Automatic replacement uses the same eligibility and ranking process.
- The withdrawn Staff Member must not be immediately selected again for the same task.
- Manager can manually select a replacement.
- If no eligible replacement exists, the task remains partially filled and the Manager is alerted.

### 10.14 Time recording and completion

- Staff Member can clock in only to an active personal assignment.
- Staff Member can clock out only when an active work session exists.
- Invalid sequences are blocked.
- Worked time is calculated from work sessions.
- Staff Member completes only their own assignment.
- One Staff Member's completion does not complete other assignments.
- Task completion is derived according to task rules and assignment coverage, not from one Staff Member button alone.

### 10.15 Availability

Temporary or Part-Time Staff can:

- view weekly availability;
- add or update weekly availability;
- maintain date-specific overrides where implemented.

Eligibility uses availability records only according to the Staff Member type and organization rule.

### 10.16 Certifications

Company Admin can manage certification definitions. Staff Members can submit and update personal certification evidence. Authorized Managers can verify or reject submissions within department scope.

Certification rejection requires a reason visible to the Staff Member.

Only verified and unexpired certifications satisfy task requirements.

### 10.17 Notifications

Core notification events:

- new active assignment;
- task update;
- task cancellation;
- reassignment or removal;
- withdrawal request requiring review;
- withdrawal approval or denial;
- replacement allocation;
- certification decision;
- working-hour alert where implemented.

Remove assignment-accepted, assignment-rejected, and unresponded-assignment event types.

### 10.18 Audit logging

Audit important actions such as:

- organization and settings changes;
- member role, department, activation, and deactivation changes;
- task creation, update, and cancellation;
- assignment, reassignment, and removal;
- warning override and reason;
- withdrawal request decision;
- replacement allocation;
- certification verification and rejection.

Each audit record should include acting user, organization, action, affected entity, timestamp, and relevant metadata.

---

## 11. Authorization Requirements

Every service and API route must enforce the relevant combination of:

1. authenticated user;
2. active organization membership;
3. organization ownership of the requested record;
4. actor role or enforced custom permission;
5. authorized department scope;
6. personal record ownership where applicable.

UI visibility is not a security control.

Custom roles are not complete merely because they can be created in the database. Assigned permissions must be enforced in routes and services.

---

## 12. Data Integrity Requirements

- Use database transactions for multi-assignment creation and other multi-record state changes.
- Prevent duplicate active assignments through database constraints or transaction-safe checks.
- Prevent headcount over-allocation under concurrent requests.
- Recalculate task coverage from authoritative assignment data.
- Do not trust client-supplied eligibility, rank, headcount, or confirmation data.
- Preserve partial work sessions on withdrawal or cancellation.
- Write notifications only after the main transaction succeeds, or use an outbox/retry strategy.
- Store all timestamps consistently.

---

## 13. Non-Functional Requirements

### Security

- Server-side authentication and authorization.
- Strict tenant isolation.
- Strict Manager department scope.
- Staff personal-record ownership enforcement.
- Input validation using shared schemas.
- No secrets or sensitive error details exposed to clients.

### Reliability

- Eligibility works without an external AI provider.
- AI provider failures use deterministic fallback.
- Email, Stripe sandbox, or AI failure does not corrupt core data.
- Important operations are idempotent where retries are possible.

### Performance

- Common listing and assignment operations respond acceptably under FYP-scale data.
- Use pagination, filtering, and suitable indexes for members, tasks, notifications, and audit logs.

### Maintainability

- Keep Boundary, Control, Entity, and database responsibilities separated.
- Centralize eligibility, authorization, assignment, and notification logic.
- Use canonical status constants or enums rather than repeated string literals.
- Keep README, PRD, diagrams, seed data, and tests synchronized with the final workflow.

### Testability

- Core services have repeatable tests.
- Tests cover positive, negative, authorization, tenant, concurrency, and external-failure cases.
- Test data uses the same actor and status terminology as production code.

---

## 14. Required Test Scenarios

### Allocation

- automatic allocation fills available headcount;
- insufficient eligible candidates results in partial fill;
- blocked candidate is never assigned;
- Manager manual selection uses the same checks;
- concurrent assignment requests cannot exceed headcount;
- multi-staff assignment rolls back completely on failure;
- Company Admin and Manager administrative memberships are not accidentally assigned as Staff Members.

### Eligibility

- inactive membership blocked;
- wrong organization blocked;
- wrong department blocked;
- unavailable candidate handled according to rule;
- schedule conflict blocked or warned according to configuration;
- hour-limit condition blocked or warned according to configuration;
- missing, rejected, or expired certification blocked;
- final revalidation catches data changed after suggestions were loaded.

### Withdrawal

- request before clock-in;
- request after clock-in;
- reason required;
- active work session closes and partial time is preserved;
- pending request does not remove assignment;
- approval withdraws assignment and recalculates coverage;
- denial restores an active assignment path;
- replacement auto-allocation succeeds;
- replacement manual selection succeeds;
- no replacement leaves task partially filled;
- withdrawn Staff Member is not immediately reselected.

### Security

- cross-tenant record identifiers rejected;
- cross-department Manager access rejected;
- Staff Member cannot read another Staff Member's private records;
- custom permission is enforced server-side;
- client-forged eligibility or confirmation values ignored.

### Subscription

- active members count toward limit;
- pending invitations count toward limit;
- concurrent invitation or acceptance cannot exceed limit;
- plan checks are server-side.

---

## 15. Definition of Done

A feature is done only when:

- its requirement is implemented;
- server-side authorization is applied;
- input validation is applied;
- organization and department scope are applied;
- positive and negative tests exist;
- notification and audit behavior is implemented where required;
- README or relevant technical documentation is updated;
- obsolete acceptance/rejection terminology is removed;
- `npm run lint`, `npm test`, and `npm run build` pass;
- Prisma schema and migrations are valid;
- the feature can be demonstrated using documented demo accounts.

---

## 16. Repository Documentation Required

The repository should contain and maintain:

- `PRD.md` - this product source of truth;
- `list.md` - implementation alignment checklist;
- `README.md` - setup, architecture, current verified features, and demo instructions;
- `docs/ARCHITECTURE.md` - system boundaries and BCE flow;
- `docs/DATA_MODEL.md` - entities, statuses, and relationships;
- `docs/ALLOCATION_FLOW.md` - eligibility, ranking, automatic allocation, manual assignment, withdrawal, and replacement;
- `docs/AUTHORIZATION.md` - organization, role, department, permission, and ownership rules;
- `docs/NOTIFICATIONS_AND_AUDIT.md` - events and recorded actions;
- `docs/TEST_MATRIX.md` - requirement-to-test mapping and current results;
- `docs/KNOWN_LIMITATIONS.md` - incomplete, partial, or deferred functions;
- `.env.example` - required variables without secrets.

---

## 17. Migration Notes from the Old Workflow

The implementation team must search and revise all code, schema, tests, UI, and documentation containing:

```text
taskAcceptanceMode
auto_accept
pending acceptance
accept assignment
reject assignment
assignment accepted
assignment rejected
unresponded assignment
ASSIGNMENT_ACCEPTED
ASSIGNMENT_REJECTED
taskRejection
```

Migration target:

- default allocation mode becomes automatic;
- assignments are immediately `assigned`;
- acceptance and rejection actions are removed;
- withdrawal is supported from `assigned` and `in_progress`;
- work sessions preserve partial time;
- notifications and audit events reflect assignment, withdrawal, and replacement rather than acceptance or rejection.


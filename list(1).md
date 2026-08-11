# ShiftHappens Codebase Alignment Checklist

**Reviewed archive:** `ShiftHappens-main (5).zip`  
**Archive commit marker:** `fbf5b26029174e907c04c5c703cfe7da1db11b3c`  
**Review date:** 31 July 2026  
**Review method:** Static code audit of Prisma schema, routes, services, repositories, pages, components, tests, seeds, README, PRD, and UAT plan.

> This checklist is based on the actual uploaded code, not only the public GitHub README.
>
> Test execution was attempted but dependency installation failed because the available package registry could not retrieve `zod-validation-error@4.0.2`. Therefore, all implementation findings below are static findings until the project is run in the team's normal development environment.

---

## 1. Recheck Summary

### Already present in the uploaded code

- [x] Next.js App Router, TypeScript, Prisma, PostgreSQL, NextAuth, Zod, Tailwind, and Vitest structure.
- [x] Public landing page and authentication routes.
- [x] Organization onboarding, departments, members, invitations, CSV/XLSX import, roles, settings, and work rules.
- [x] Platform Admin tenant pages and APIs.
- [x] Task CRUD and recurring-task generation.
- [x] Availability and date-specific overrides.
- [x] Staff certification submission, verification, rejection, revocation, and rejection reason.
- [x] Eligibility checks for hours, availability, scheduling conflicts, work rules, and required certifications.
- [x] AI provider failover and deterministic fallback ranker.
- [x] Task suggestions, per-task auto-allocation, and weekly auto-schedule draft generation.
- [x] Clock-in, clock-out, and assignment-completion routes.
- [x] Basic withdrawal request and Manager decision routes.
- [x] In-app notifications, hour alerts, audit logs, calendars, dashboards, and reports.
- [x] Stripe Checkout session creation and verified webhook handling.
- [x] Active-membership authorization and several department-scope helpers.

### Major misalignment with the final approved documentation

- [x] Code still requires or supports assignment acceptance and rejection.
- [x] Default allocation is still `manual`; a third `suggested` mode still exists.
- [x] `taskAcceptanceMode` still controls `pending` versus `accepted` assignment creation.
- [x] Assignment lifecycle still uses `pending`, `accepted`, and `rejected`.
- [x] Staff UI and dashboards still show pending assignments, acceptance rate, accepted, and rejected counts.
- [x] Managers are included as assignable candidates.
- [x] Manual and auto-schedule confirmation do not perform complete final eligibility revalidation.
- [x] Multi-staff assignment is not atomic or concurrency-safe.
- [x] Withdrawal approval deletes the assignment and can remove clock evidence.
- [x] Approved withdrawal does not automatically create a replacement assignment.
- [x] Employment types and availability rules do not match the approved WBS.
- [x] Organization certification definitions do not exist as a separate model.
- [x] Custom-role permissions are configurable but not enforced across operational routes.
- [x] Configurable ranking priorities are stored but are not connected to ranking.
- [x] Auto-schedule confirmation trusts the client-provided draft.
- [ ] Pending invitations are not included in the subscription member count, and invitation acceptance does not recheck the limit.
- [x] Task data has no dedicated location or instructions fields.
- [ ] README, root PRD, UAT plan, seeds, dashboards, reports, and tests contain obsolete workflow terminology.

---

# P0 — Required before claiming code/document alignment

## 2. Remove Staff Member assignment acceptance and rejection

### Previous evidence

```text
src/app/api/assignments/[assignmentId]/accept/route.ts
src/app/api/assignments/[assignmentId]/reject/route.ts
src/services/task-assignment.service.ts
src/repositories/task-assignment.repository.ts
src/app/(app)/org/[orgId]/my-tasks/page.tsx
src/components/dashboard/staff-dashboard.tsx
src/components/dashboard/manager-dashboard.tsx
src/components/dashboard/admin-dashboard.tsx
README.md
docs/UAT-TEST-PLAN.md
tests/services/task-assignment.service.test.ts
tests/api/routes.manifest.ts
```

### Required changes

- [x] Delete or retire the accept route and service method.
- [x] Delete or retire the reject route, schema, service method, and assignment rejection fields.
- [x] Remove Accept and Reject buttons and forms from `my-tasks/page.tsx`.
- [x] Remove pending-acceptance and assignment-rejection dashboards and reports.
- [x] Remove assignment acceptance/rejection notification and audit event types.
- [x] Replace obsolete tests with immediate-active-assignment tests.
- [x] Keep certification rejection behavior; do not remove certification rejection.

Done when new assignments require no Staff Member response and global search finds no obsolete assignment behavior outside migration/history notes.

Search terms:

```text
taskAcceptanceMode
require_acceptance
auto_accept
ASSIGNMENT_ACCEPTED
ASSIGNMENT_REJECTED
acceptanceRate
pending_acceptance
rejectionTrends
```

---

## 3. Make automatic allocation the default and remove the third allocation mode

### Current evidence

```text
prisma/schema.prisma
  CompanySettings.allocationMode @default("manual")
  CompanySettings.taskAcceptanceMode

src/lib/validations.ts
  allocationMode = manual | suggested | auto
  taskAcceptanceMode = auto_accept | require_acceptance

src/app/(app)/org/[orgId]/settings/page.tsx
src/app/(app)/org/[orgId]/tasks/page.tsx
src/services/settings.service.ts
src/repositories/settings.repository.ts
prisma/seed-demo.ts
```

### Required changes

- [x] Change the default allocation value to automatic.
- [x] Keep exactly two product choices: automatic and manual.
- [x] Remove `suggested` as an allocation mode.
- [x] Treat smart suggestions as ranking output used by both automatic and manual paths.
- [x] Remove `taskAcceptanceMode` from schema, validation, settings service, UI, seeds, and tests.
- [x] Add a migration for existing organization settings.
- [x] Update task-creation behavior so automatic allocation runs by default.

Recommended canonical values:

```text
auto
manual
```

---

## 4. Replace the assignment lifecycle

### Current evidence

```text
prisma/schema.prisma
  TaskAssignment default status = pending
  documented lifecycle pending → accepted → clocked_out → completed

src/repositories/task-assignment.repository.ts
src/services/task-assignment.service.ts
src/services/eligibility.service.ts
src/services/reporting.service.ts
src/repositories/reporting.repository.ts
src/components/ui/status-badge.tsx
```

### Required changes

- [x] Define assignment statuses in one shared constant or typed enum.
- [x] Remove `pending`, `accepted`, and assignment `rejected` from current behavior.
- [x] Create assignments as active immediately.
- [x] Change clock-in to an in-progress state or document a consistent equivalent.
- [x] Preserve `clocked_out`, `completed`, `withdrawal_requested`, `withdrawn`, and `cancelled` behavior consistently.
- [x] Update every dashboard, filter, report, seed, notification, audit action, and test.

Recommended lifecycle:

```text
assigned → in_progress → clocked_out → completed
assigned/in_progress → withdrawal_requested → assigned/in_progress or withdrawn
assigned/in_progress → cancelled
```

---

## 5. Fix withdrawal before and during task execution

### Current evidence

```text
src/services/task-assignment.service.ts
  requestWithdrawal() only accepts status "accepted"
  resolveWithdrawal(approve) calls assignmentRepo.cancel()

src/repositories/task-assignment.repository.ts
  cancel() deletes the TaskAssignment row
  clockIn() stores a timestamp but leaves status as accepted
```

Because clock-in does not change the status, the current service can technically submit a withdrawal after clock-in. However, approval deletes the assignment, which removes the row containing `clockInTime` and loses the main work record.

### Required changes

- [x] Allow withdrawal from `assigned` and `in_progress`.
- [x] Require a reason.
- [x] Keep the slot reserved while review is pending.
- [x] Do not delete the assignment on approval.
- [x] Change the assignment to `withdrawn` and preserve all timestamps.
- [x] Store request time, reviewer, decision, review time, and state at request.
- [x] If approved during work, close or preserve the partial worked interval.
- [x] If denied, restore the state before the request.
- [x] Prevent duplicate unresolved requests.
- [x] Add before-clock-in, after-clock-in, approval, denial, and partial-hours tests.

A separate `WithdrawalRequest` model is preferable, but extending `TaskAssignment` is acceptable for the FYP if history is preserved.

---

## 6. Implement actual replacement allocation

### Current evidence

```text
src/services/task-assignment.service.ts
  approved withdrawal only deletes/unassigns and notifies

src/services/task.service.ts
  suggestReplacement() only sends a recommendation notification
```

### Required changes

- [x] Recalculate coverage after approved withdrawal or Manager removal.
- [x] Use the central eligibility and ranking engine.
- [x] Exclude withdrawn or removed Staff Members from immediate reselection for the same task.
- [x] Automatic replacement must create the replacement assignment.
- [x] Manual replacement selection must remain available.
- [x] If no replacement exists, keep the task partially filled and alert the Manager.
- [x] Add automatic, manual, and no-candidate tests.

Do not describe “Smart swap” as implemented replacement allocation while it only sends a suggestion.

---

## 7. Revalidate complete eligibility immediately before assignment

### Phase 4 implementation

```text
src/services/eligibility.service.ts::assertEligibleForAssignment()
  reruns every authoritative eligibility rule for the selected membership IDs

src/services/task.service.ts::assignStaff()
  sends manual, automatic, replacement, and auto-schedule assignments through the final gate
```

### Required changes

- [x] Centralize a final eligibility assertion used by manual, automatic, reassignment, replacement, and auto-schedule paths.
- [x] Verify active membership and assignable Staff Member role.
- [x] Verify department membership.
- [x] Verify availability where applicable.
- [x] Verify overlap.
- [x] Verify daily and weekly hour limits.
- [x] Verify required verified and unexpired certifications.
- [x] Verify work rules.
- [x] Verify no duplicate active assignment.
- [x] Verify remaining headcount.
- [x] Ignore stale client-side eligibility or ranking information.

---

## 8. Restrict assignable candidates to Staff Members

### Phase 4 implementation

```text
src/lib/role-config.ts
  defines the reusable assignable Staff Member role rule

src/services/eligibility.service.ts and src/services/auto-schedule.service.ts
  exclude managers, company admins, platform admins, and inactive memberships
```

### Required changes

- [x] Exclude Manager memberships from candidate listing, ranking, automatic allocation, manual assignment, and auto-schedule.
- [x] Exclude Company Admin and Platform Admin actors.
- [x] Exclude inactive memberships.
- [x] Define assignable roles once and reuse the rule everywhere.
- [x] Add tests proving Managers and Company Admins cannot be assigned.

---

## 9. Make batch assignment atomic and concurrency-safe

### Phase 4 implementation

```text
src/repositories/task-assignment.repository.ts::createBatchAtomic()
  rechecks headcount and selected memberships in a serializable Prisma transaction

src/services/auto-schedule.service.ts::confirmSchedule()
  submits each task batch through the same atomic TaskService assignment path
```

### Required changes

- [x] Use a Prisma transaction for final headcount check and assignment creation.
- [x] Re-read active count inside the transaction.
- [x] Validate all selected Staff Members before writing any assignment.
- [x] Roll back the whole manual or automatic batch if a required assignment fails.
- [x] Prevent concurrent requests from exceeding required headcount.
- [x] Send notifications only after successful creation.
- [x] Add failure-path and concurrent-headcount tests.

---

## 10. Stop trusting auto-schedule confirmation payloads

### Phase 5 implementation

```text
src/lib/validations.ts::confirmAutoScheduleSchema
  accepts only unique taskId and membershipId references

src/services/auto-schedule.service.ts::confirmSchedule()
  resolves tasks and members server-side, applies scope and final eligibility,
  rejects cross-draft overlaps, and submits one authoritative schedule batch

src/repositories/task-assignment.repository.ts::createScheduleAtomic()
  rechecks tenant, role, department, duplicate, and headcount constraints in
  one serializable transaction before creating every assignment
```

### Required changes

- [x] Validate the request body with Zod.
- [x] Resolve every task and membership on the server.
- [x] Confirm same organization and authorized department scope.
- [x] Recheck Staff Member role, active status, eligibility, duplicate assignment, and headcount.
- [x] Do not trust `taskTitle`, `staffName`, `reasoning`, or candidate score from the client.
- [x] Make confirmation atomic where possible.
- [x] Add tampered-ID and cross-tenant tests.

---

## 11. Align employment types and availability with the approved WBS

### Phase 6 implementation

```text
src/lib/role-config.ts
  defines casual and temporary_part_time as the canonical employment types,
  maps legacy values to casual, and centralizes the availability policy

prisma/migrations/20260801010000_align_employment_types/migration.sql
  migrates legacy full_time memberships and invitations to casual

src/services/eligibility.service.ts and src/services/auto-schedule.service.ts
  require managed weekly availability only for Temporary or Part-Time Staff

src/lib/import-config.ts, invitation/member services, seeds, and member UI
  use the canonical values and normalize supported legacy import aliases
```

The approved WBS instead distinguishes Casual Staff and Temporary or Part-Time Staff, with availability management under Temporary or Part-Time Staff.

### Required decision and changes

- [x] Confirm canonical types: `casual` and `temporary_part_time`.
- [x] Migrate or map legacy `full_time` values.
- [x] Update invitation, member edit, import, seed, UI, validation, and eligibility code.
- [x] Apply availability to the approved Staff Member type.
- [x] Update documentation and tests.

Do not leave the code and final report describing opposite availability behavior.

---

## 12. Add missing task fields or revise the documentation

### Phase 7 implementation

```text
prisma/schema.prisma
prisma/migrations/20260801030000_add_task_details/migration.sql
  add nullable location and instructions fields without invalidating existing tasks

src/lib/validations.ts
src/repositories/task.repository.ts
src/services/task.service.ts
src/services/recurring-task.service.ts
src/services/ai-task-parser.service.ts
  validate and persist task details, extract them from natural-language input,
  preserve them on recurring instances, and keep omitted schedule fields unchanged

src/app/(app)/org/[orgId]/tasks/page.tsx
src/app/(app)/org/[orgId]/my-tasks/page.tsx
  provide compact create/edit/detail controls for Managers and visible assignment
  details for Staff

tests/lib/validations.test.ts
tests/repositories/task.repository.test.ts
tests/services/task.service.test.ts
tests/services/recurring-task.service.test.ts
tests/services/ai-task-parser.test.ts
  cover validation limits, CRUD persistence, recurrence, parser output, and
  partial-update schedule preservation
```

### Required action

- [x] Add `location` and `instructions` fields with migration, validation, UI, service, repository, tests, and task-detail display; or
- [ ] explicitly reduce the final report requirement and explain that description stores the combined information.

Adding dedicated fields is cleaner and matches the documented task details.

---

## 13. Implement organization certification definitions or reduce the requirement

### Phase 8 implementation

```text
prisma/schema.prisma
prisma/migrations/20260801040000_add_certification_definitions/migration.sql
  add organization-scoped CertificationDefinition and a department join model
  with per-department required status

src/repositories/certification-definition.repository.ts
src/services/certification-definition.service.ts
src/app/api/organizations/[orgId]/certification-definitions
  provide tenant-scoped CRUD, duplicate prevention, active filtering,
  department ownership validation, audit events, and Company Admin mutation gates

src/components/certifications/certification-definition-manager.tsx
src/app/(app)/org/[orgId]/certifications/page.tsx
src/app/(app)/org/[orgId]/my-certifications/page.tsx
src/app/(app)/org/[orgId]/tasks/page.tsx
  add compact catalogue management, approved Staff submission choices, and
  automatic department-required task qualifications

src/repositories/certification.repository.ts
src/services/certification.service.ts
src/app/api/organizations/[orgId]/certifications
  keep Company Admin review unrestricted while limiting Managers to Staff
  certification submissions within their assigned departments

tests/repositories/certification-definition.repository.test.ts
tests/services/certification-definition.service.test.ts
tests/api/certification-definitions.route.test.ts
  cover CRUD, validation, tenant isolation, canonical names, role gates,
  inactive definitions, and department assignment replacement
```

### Required action

- [x] Add an organization-scoped `CertificationDefinition` model and CRUD; or
- [ ] revise the WBS/report to state that Company Admins manage Staff Member certification records rather than definitions.

Because the Supervisor-approved WBS includes certification creation, update, deletion, department assignment, and required status, the code currently does not fully support that branch.

Recommended model fields:

```text
id
organizationId
name
description
isActive
createdAt
updatedAt
```

Optional relation: department requirements or a join model.

---

## 14. Enforce custom-role permissions or stop claiming full RBAC

### Current evidence

```text
Role, Permission, and RolePermission models exist.
Role CRUD and assignment exist.
Operational routes primarily check membership.role strings.
No shared hasPermission()/requirePermission() enforcement was found.
```

### Required changes

- [x] Add a shared permission-resolution helper.
- [x] Enforce custom permissions on relevant APIs and services.
- [x] Preserve organization, department, and record-ownership restrictions.
- [x] Add permission-denied and permission-granted tests.
- [x] Until complete, describe custom roles as configuration only or Planned, not fully enforced RBAC.

---

## 15. Connect ranking priorities to actual ranking

### Current evidence

```text
CompanySettings.smartAllocationWeights exists.
Settings validation/UI do not provide a complete weight update path.
AllocationService.buildCandidate() passes fixed candidate attributes.
FallbackRanker uses its own fixed logic.
```

### Required changes

- [x] Define supported factors and allowed ranges.
- [x] Validate and normalize weights.
- [x] Use organization weights in deterministic ranking.
- [x] Include allowed priorities in AI ranking prompts without allowing AI to affect eligibility.
- [x] Display reasons tied to the actual factors used.
- [x] Add tests showing that changed priorities change ranking order.

---

## 16. Fix subscription member-limit integrity

### Current evidence

```text
src/repositories/subscription.repository.ts
  members count = active Membership rows only

src/services/user-management.service.ts::inviteUser()
  checks active member count before creating invitation

src/services/invitation.service.ts::acceptInvitation()
  creates membership without rechecking the limit
```

### Required changes

- [ ] Count active memberships plus valid pending invitations.
- [ ] Check the limit when creating an invitation.
- [ ] Recheck the limit when accepting an invitation.
- [ ] Make acceptance and membership creation transaction-safe.
- [ ] Apply the same integrity rule to batch import and manual add flows.
- [ ] Add Free 10, Pro 50, pending-invite, expiry, and concurrent-acceptance tests.

---

# P1 — Security and scope corrections

## 17. Audit organization suspension checks

- [ ] Add `checkOrgSuspended()` consistently to organization write routes.
- [ ] Review `tasks/[taskId]/auto-allocate/route.ts`, assignment action routes, report routes, and invitation GET.
- [ ] Add tests proving suspended tenants cannot perform operational writes.

## 18. Apply Manager department scope to reports and dashboards

### Current evidence

```text
src/app/api/organizations/[orgId]/reports/route.ts
  allows manager role
  calls getDashboardReports(orgId) without department scope
```

- [ ] Pass the Manager's department scope into reporting queries.
- [ ] Scope PDF export for Managers or restrict export to Company Admin.
- [ ] Verify dashboard, calendar, certifications, withdrawals, staff lists, and reports use consistent scope.

## 19. Distinguish strict blocks, warnings, and permitted overrides

### Current evidence

The eligibility engine currently returns boolean eligible/ineligible. Overrides can target hours, availability, scheduling, work rules, certifications, or `all`, meaning every failed rule can be bypassed.

- [ ] Define which conditions are strict blocks.
- [ ] Define which conditions are warnings.
- [ ] Do not permit blanket `all` override for strict rules.
- [ ] Require explicit override permission.
- [ ] Keep a mandatory reason and audit record.
- [ ] Update eligibility response, UI, and tests.

## 20. Keep reports and extra AI features from distorting the core scope

The code includes PDF reports, rejection trends, weekly auto-schedule, AI dashboard insights, and coverage analytics. These may remain, but:

- [ ] Remove assignment acceptance/rejection analytics.
- [ ] Do not present optional analytics as the project's central contribution.
- [ ] Keep Chapter 6 honest about implemented supplementary features.
- [ ] Hide or defer features that are not stable enough for the final demo.

---

# P2 — Documentation, tests, and repository hygiene

## 21. Replace stale implementation status in the root PRD

The current root `PRD.md` incorrectly lists several implemented functions as remaining, including Stripe checkout/webhook, withdrawal routes, completion endpoint, recurring generation, and system notifications.

- [ ] Replace it with the revised `PRD.md` supplied with this checklist.
- [ ] Keep implementation completion claims in a separate audited status table.

## 22. Update README

Current obsolete statements include assignment acceptance/rejection and three allocation modes.

- [ ] Describe automatic allocation as default.
- [ ] Describe manual assignment as alternative.
- [ ] Explain suggestions as shared ranking output.
- [ ] Remove assignment accept/reject workflow.
- [ ] Update assignment status descriptions.
- [ ] Document actual Stripe, cron, reports, and environment setup accurately.
- [ ] Do not state a passing test count until rerun after refactoring.

## 23. Rewrite UAT plan

Current UAT explicitly asks Staff Members to accept/reject tasks and treats only accepted tasks as clockable.

- [ ] Replace those cases with immediate assignment visibility.
- [ ] Add withdrawal before clock-in.
- [ ] Add withdrawal after clock-in and partial worked-time preservation.
- [ ] Add Manager approval, denial, automatic replacement, manual replacement, and no-candidate cases.
- [ ] Add automatic-default and manual-alternative allocation cases.

## 24. Update tests and route manifest

- [ ] Remove accept/reject routes from `tests/api/routes.manifest.ts`.
- [ ] Rewrite `task-assignment.service.test.ts`.
- [ ] Update eligibility-hour tests to canonical statuses.
- [ ] Replace reporting acceptance/rejection metrics tests.
- [ ] Update settings, allocation, auto-schedule, smart-swap, notification, and tenant-isolation fixtures.
- [ ] Add atomicity, final revalidation, role exclusion, mid-task withdrawal, and client-tampering tests.

## 25. Update seeds and duplicate schema documentation

- [ ] Update `prisma/seed-demo.ts` settings and assignment states.
- [ ] Update `tests/helpers/fixtures.ts`.
- [ ] Update `supabase-schema.sql` or remove it if Prisma is the sole schema source.
- [ ] Ensure migrations, Prisma schema, seed data, and SQL reference files do not disagree.

## 26. Add repository documentation

Recommended files:

```text
docs/ASSIGNMENT-LIFECYCLE.md
docs/ELIGIBILITY-RULES.md
docs/AUTHORIZATION.md
docs/ARCHITECTURE.md
docs/ENVIRONMENT.md
docs/TESTING.md
docs/DECISIONS.md
```

Minimum content:

- canonical statuses and transitions;
- automatic/manual allocation behavior;
- eligibility factors and strict/warning rules;
- actor, tenant, department, and ownership checks;
- AI provider and fallback behavior;
- Stripe sandbox and webhook setup;
- cron jobs;
- test database and commands;
- important scope decisions and superseded behavior.

---

# Recommended implementation order

1. Remove accept/reject UI and APIs.
2. Remove `taskAcceptanceMode`; change default allocation to automatic.
3. Migrate assignment statuses and update dashboard/report terminology.
4. Fix withdrawal history and partial worked-time preservation.
5. Centralize final eligibility validation.
6. Exclude Managers and Company Admins from assignable candidates.
7. Make assignment creation transactional and headcount-safe.
8. Implement real replacement allocation.
9. Secure auto-schedule confirmation.
10. Resolve employment-type and availability mismatch.
11. Add missing task fields and certification definitions, or revise the report before submission.
12. Fix subscription pending-invitation integrity.
13. Enforce custom permissions or mark them Planned.
14. Update README, PRD, UAT, seeds, reports, and tests.

---

# Minimum demo acceptance checklist

- [x] New organization defaults to automatic allocation.
- [x] A Manager creates a task with department, schedule, headcount, requirements, location, and instructions.
- [x] Eligibility excludes inactive, wrong-department, unavailable, conflicting, over-limit, uncertified, Manager, and Company Admin candidates.
- [x] Automatic allocation creates immediate active assignments.
- [x] Manual assignment uses the same eligibility results.
- [x] Staff sees the assignment without accepting it.
- [x] Staff can clock in, clock out, and complete their own assignment.
- [x] Staff can request withdrawal before clock-in.
- [x] Staff can request withdrawal after clock-in without losing worked time.
- [x] Manager can approve or deny within department scope.
- [x] Approval triggers automatic or manual replacement allocation.
- [x] No replacement leaves the task visibly partially filled.
- [x] Notifications and audit events are produced.
- [x] Cross-tenant and cross-department requests are rejected.
- [x] Concurrent assignment cannot exceed headcount.
- [ ] Pending invitations cannot bypass plan limits.

---

# Verification commands

Run these in the team's normal development environment after dependencies and databases are available:

```bash
npm ci
npx prisma validate
npx prisma generate
npm run lint
npm run test
npm run test:utc
npm run build
```

Repository-wide obsolete-workflow scan:

```bash
rg -n "taskAcceptanceMode|require_acceptance|auto_accept|ASSIGNMENT_ACCEPTED|ASSIGNMENT_REJECTED|acceptanceRate|pending_acceptance|rejectionTrends" .
```

Review every match. Certification rejection matches are valid and should not be removed accidentally.

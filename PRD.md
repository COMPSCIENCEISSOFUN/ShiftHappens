# Smart Task Allocation — Product Requirements Document

> **Project**: ShiftHappens (Smart Task Allocation)  
> **Version**: 2.0 (Revised June 2026)  
> **Team**: Group 22 — CSIT321 Final Year Project  
> **Supervisor**: Liaw Chun Huei  
> **Stack**: Next.js 16 · TypeScript · Prisma · PostgreSQL · NextAuth v5 · Tailwind CSS · shadcn/ui

---

## 1. Overview

Smart Task Allocation is a multi-tenant SaaS web application that helps small and medium-sized businesses manage casual staff task allocation. The system centralizes task creation, staff eligibility checking, ranked staff suggestions, assignment, time tracking, notifications, and audit logging in one platform.

### 1.1 Problem Statement

Businesses relying on casual/hourly staff often manage allocation through spreadsheets or messaging apps. This leads to missed eligibility checks, overlapping assignments, unclear accountability, and slow decision-making.

### 1.2 Solution

A web-based platform that:
- Checks staff eligibility (availability, certifications, hour limits, department scope) before assignment
- Provides AI-assisted ranked staff suggestions with clear explanations
- Supports manager-confirmed or auto-assignment workflows
- Records important actions in audit logs for accountability
- Enforces subscription-based member limits

### 1.3 Key Differentiators

| Differentiator | Description |
|---|---|
| Task-level allocation | Assigns staff to specific tasks (not just shifts) |
| Unified eligibility engine | Checks availability, certs, hours, overlaps, and dept scope together |
| Explainable suggestions | Shows ranked staff with clear reasons for each recommendation |
| Configurable enforcement | Supports strict blocks AND warning-based overrides with recorded reasons |
| Allocation auditability | Records assignments, overrides, cert decisions, clock adjustments |
| Department-scoped access | Clear role boundaries (Platform Admin → Company Admin → Manager → Staff) |

---

## 2. User Roles and Access

### 2.1 Role Hierarchy

| Track | Role | Scope |
|---|---|---|
| Public | Unregistered User | Landing page, pricing, registration |
| Management | Platform Admin | Platform-wide tenant management |
| Management | Company Admin | Organization-wide (inherits Manager capabilities) |
| Management | Manager | Assigned department(s) within one organization |
| Workforce | Staff Member | Own profile, tasks, availability, certifications |

### 2.2 Role Rules

- Platform Admins manage tenants but do NOT participate in task allocation
- Company Admins have company-wide access and inherit Manager-level capabilities
- Managers access only tasks/staff/certs within their assigned department scope
- Staff Members can belong to multiple departments within the same organization
- Each organization operates as a separate tenant with isolated data
- Company Admins can invite users only within the subscription plan's member limit

### 2.3 Employment Types

Staff Members have an employment type that affects scheduling:
- **Casual** — default, flexible availability
- **Full-time** — standard schedule expectations

---

## 3. Subscription Plans

The positioning, as of 2026-08-14:

- **Free** = core workforce management + deterministic eligibility + manual allocation.
- **Pro / Enterprise** = smart ranking + AI + automation + Projects + advanced tools.

Free is a complete workforce manager within its limits: organisations,
departments, members, built-in roles, tasks and recurrences, availability,
leave, certifications and verification, working-hour and overlap checks, the
deterministic eligibility engine with its reasons, manual and multi-staff
assignment, reassignment, permitted overrides with a reason, withdrawal
requests and their approval, basic replacement assignment, clock in/out, task
history, notifications, the calendar and the basic dashboard. Nothing in that
list costs a provider call or runs unattended.

What sits above Free is everything that ranks, decides or spends on the
organisation's behalf, plus Projects, reporting export, integrations and the
premium analytics and audit surfaces.

| Plan | Member Limit | Price (Monthly) | Key Features |
|---|---|---|---|
| Free | Up to 10 | $0 | Core workforce management, 3 departments, 3 work rules, 20 active tasks. No AI, automation, Projects or custom roles |
| Pro | Up to 50 | $29 | Smart ranked suggestions, auto-allocation, weekly auto-schedule, NL task creation, AI assistant, advanced analytics, 10 Projects, custom roles, PDF export, mass import, calendar sync, audit log |
| Enterprise | Unlimited | $59 | Everything in Pro, plus priority support and unlimited everything |

`src/lib/subscription-tiers.ts` is the single source of truth for the grid;
this table is a summary of it and `tests/services/tier-feature-matrix.test.ts`
is what stops the two drifting.

### 3.1 Stripe Integration (Sandbox/Test Mode)

- Stripe checkout for paid plan selection during registration
- Webhook handling for subscription lifecycle events
- Test mode only — no real payments processed
- Production billing (recurring billing, invoices, refunds, proration) is out of scope

---

## 4. Functional Requirements — User Stories

### 4.1 Unregistered User (Public Website)

| ID | User Story | Area |
|---|---|---|
| 1 | View landing page and product overview | Public Website |
| 2 | View feature benefits | Public Website |
| 3 | View tutorial or marketing content | Public Website |
| 4 | View pricing and subscription plans (Free, Pro, Enterprise) | Public Website |
| 5 | View contact information | Public Website |
| 6 | View privacy policy and terms of service | Public Website |
| 7 | Select a subscription plan | Subscription & Registration |
| 8 | Complete payment for a paid plan (Stripe sandbox) | Subscription & Registration |
| 9 | Register as Company Admin | Subscription & Registration |
| 10 | Verify email during registration | Subscription & Registration |
| 11 | Register organization after account creation | Subscription & Registration |

### 4.2 All Authenticated Users

| ID | User Story | Area |
|---|---|---|
| 12 | Log in with email and password | Authentication |
| 13 | Log out securely | Authentication |
| 14 | Reset password via email | Authentication |
| 15 | Update own profile details | Profile |
| 16 | View notification inbox and mark as read | Notifications |
| 17 | See role-specific dashboard on login | Dashboard |

### 4.3 Platform Admin

| ID | User Story | Area |
|---|---|---|
| 18 | View company tenants (name, status, user count, created date) | Tenant Management |
| 19 | Update a company tenant's details | Tenant Management |
| 20 | Activate or deactivate a company tenant | Tenant Management |
| 21 | View platform-wide metrics (companies, users, tasks, trends) | Metrics |

### 4.4 Company Admin

| ID | User Story | Area |
|---|---|---|
| 22 | Update organization profile (name, logo, industry, address) | Organization |
| 23 | View current subscription plan | Subscription |
| 24 | View current member usage | Subscription |
| 25 | See whether member limit is reached | Subscription |
| 26 | Upgrade subscription plan | Subscription |
| 27 | Downgrade subscription plan | Subscription |
| 28 | Create a new department | Departments |
| 29 | View departments (name, managers, staff count) | Departments |
| 30 | Update department details | Departments |
| 31 | Delete a department | Departments |
| 32 | Invite a new user to the company | Users |
| 33 | View users (role, department, status) | Users |
| 34 | Update user's role or department | Users |
| 35 | Activate or deactivate a user account | Users |
| 36 | View affected task assignments when deactivating a user | Users |
| 37 | Create a custom role with specific permissions | RBAC |
| 38 | View all roles (default + custom) | RBAC |
| 39 | Update a role's details/permissions | RBAC |
| 40 | Delete a custom role | RBAC |
| 41 | Create an eligibility rule (hour limits, cert requirements, enforcement mode) | Eligibility Rules |
| 42 | View all eligibility rules | Eligibility Rules |
| 43 | Update an eligibility rule | Eligibility Rules |
| 44 | Delete an eligibility rule | Eligibility Rules |
| 45 | Configure task allocation settings (mode, ranking priorities) | Settings |
| 46 | Configure workforce rules | Settings |
| 47 | Configure notification preferences | Settings |
| 48 | View dashboard summaries | Reporting |
| 49 | View task issue alerts | Reporting |
| 50 | View audit logs | Audit |

### 4.5 Manager

| ID | User Story | Area |
|---|---|---|
| 51 | Accept invitation and set up account | Onboarding |
| 52 | View manager dashboard (tasks, issues, department activity) | Dashboard |
| 53 | Create a new task (description, date, time, headcount, certs, priority) | Tasks |
| 54 | Create a recurring task with repeating schedule | Tasks |
| 55 | View tasks in department (status, staff, history, notes) | Tasks |
| 56 | Search and filter tasks (date, status, staff, certification) | Tasks |
| 57 | Update task details and notes | Tasks |
| 58 | Cancel a task (notify affected staff) | Tasks |
| 59 | View AI-assisted ranked staff suggestions for a task | Allocation |
| 60 | View explanation reasons for staff suggestions | Allocation |
| 61 | Confirm one or more staff members for a task | Allocation |
| 62 | Reassign a task to different staff | Allocation |
| 63 | Be warned about overlapping task assignments | Allocation |
| 64 | Override eligibility warning with a reason (where allowed) | Allocation |
| 65 | Auto-assign best-fit staff (when company settings allow) | Allocation |
| 66 | View, search, and filter staff by availability/certs/hours | Staff Oversight |
| 67 | Verify a staff member's uploaded certification | Staff Oversight |
| 68 | Reject a certification with a reason | Staff Oversight |
| 69 | Receive notification when staff requests task withdrawal | Notifications |
| 70 | Receive notification when a task is overdue | Notifications |
| 71 | Receive task issue alerts (staff ineligible/unavailable) | Notifications |
| 72 | Receive hour-limit alert for approaching limits | Notifications |

### 4.6 Staff Member

| ID | User Story | Area |
|---|---|---|
| 73 | View staff dashboard (assigned, upcoming, completed, notifications) | Dashboard |
| 74 | View assigned tasks (details, notes, time, requirements) | Tasks |
| 75 | Assigned tasks appear automatically after Manager confirmation | Tasks |
| 76 | Request to withdraw from assigned task with reason | Tasks |
| 77 | Clock in and out of a task | Time Tracking |
| 78 | Mark assigned task as completed | Tasks |
| 79 | View past/completed task history | Tasks |
| 80 | View tasks in calendar view | Calendar |
| 81 | Subscribe to iCal feed | Calendar |
| 82 | View own profile (hours worked, remaining hours, certifications) | Profile |
| 83 | Manage availability (recurring weekly + date-specific overrides) | Availability |
| 84 | Manage certifications (upload, update, expiry dates) | Certifications |
| 85 | Receive hour-limit alert approaching allowed hours | Notifications |
| 86 | Receive notification when new task assigned | Notifications |
| 87 | Receive notification when certification is expiring | Notifications |

---

## 5. Priority Classification

### 5.1 Must-Have (MVP)

- Authentication (login, register, email verify, password reset, invitation acceptance)
- Landing page with pricing
- Subscription plan selection + Stripe sandbox checkout
- Organization setup + onboarding
- Department management (CRUD)
- Role-based access control + member-limit enforcement
- Task creation (one-off, with date/time/headcount/priority/certs)
- Staff availability management (weekly + overrides)
- Certification records (submit, verify, reject)
- Working hour limit checks
- AI-assisted ranked staff suggestions with explanations
- Manager-confirmed assignment + notification to staff
- Staff task withdrawal request
- Staff clock in/out + mark task as completed
- Basic notifications (assignment, withdrawal, overdue)
- Audit logs for important actions

### 5.2 Should-Have

- Recurring tasks with instance generation
- Auto-assignment mode
- Calendar view (department + personal)
- Dashboard summaries (Company Admin + Manager)
- Subscription plan upgrade/downgrade
- Task issue alerts page
- Manager clock-time adjustment
- CSV/PDF export
- Eligibility warning display + override during assignment flow

### 5.3 Nice-to-Have

- iCal feed subscription
- Advanced custom role configuration
- Platform-wide metrics (trends, charts)
- Billing history / invoice download
- Certification expiry notifications (scheduled)
- Predictive alerts (approaching limits, coverage gaps)

---

## 6. Technical Architecture

### 6.1 Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| Database | PostgreSQL |
| ORM | Prisma 6 |
| Authentication | NextAuth v5 (credentials) |
| Payment | Stripe (test mode) |
| Email | Resend |
| UI | shadcn/ui + Tailwind CSS 4 |
| Icons | Lucide React |
| Validation | Zod v4 |
| Testing | Vitest + Testing Library |
| Excel Import | xlsx |
| Theming | next-themes (dark mode) |

### 6.2 Multi-Tenant Architecture

- Each organization is a separate tenant identified by `orgId`
- All data queries are scoped by `organizationId`
- Route groups: `(auth)` for public auth, `(app)` for authenticated org users, `(platform)` for platform admins
- URL pattern: `/org/[orgId]/...` for org-scoped pages

### 6.3 Database Schema (Key Models)

| Model | Purpose |
|---|---|
| User | Account, auth, platform admin flag |
| Organization | Tenant with subscription tier, Stripe IDs, status |
| Membership | Links user → org with role + employment type |
| Department | Org structure unit |
| DepartmentMembership | Links member → department(s) |
| Task | Work item with scheduling, priority, headcount |
| TaskAssignment | Links task → member with status, clock times |
| Availability | Recurring weekly schedule |
| AvailabilityOverride | Date-specific availability changes |
| Certification | Staff qualifications with verification workflow |
| WorkRule | Configurable hour limits, break rules |
| EligibilityOverride | Recorded rule overrides with reason |
| CompanySettings | Allocation mode, acceptance mode, operating hours |
| Role / Permission | Custom RBAC |
| AuditLog | Action history |
| Notification | In-app alerts |
| IndustryTemplate | Pre-configured org setup templates |

---

## 7. Key Workflows

### 7.1 Registration Flow

1. View landing page → Select plan → Stripe checkout (paid plans)
2. Create account (name, email, password)
3. Register organization (name, industry, address, logo)
4. Verify email
5. Redirect to onboarding/dashboard

### 7.2 Task Allocation Flow

1. Manager creates task (title, date/time, headcount, required certs, priority)
2. System generates ranked staff suggestions (checks availability, certs, hour limits, overlaps, dept scope)
3. Manager reviews suggestions with explanations
4. Manager confirms assignment (or system auto-assigns if enabled)
5. System validates eligibility — shows warnings for issues
6. If warning: Manager can override with recorded reason (or blocked if strict rule)
7. Staff receives notification → task appears in their list
8. Staff clocks in → works → clocks out → marks completed

### 7.3 Staff Withdrawal Flow

1. Staff requests withdrawal with required reason
2. System notifies Manager
3. Manager reviews and reassigns if needed

### 7.4 Eligibility Check Factors

- **Availability**: Is staff available during the task time slot?
- **Certifications**: Does staff have the required verified certifications?
- **Hour Limits**: Would this task push staff over their weekly/daily limit?
- **Task Overlap**: Does staff have another task at the same time?
- **Department Scope**: Is staff assigned to the task's department?

---

## 8. Constraints and Assumptions

### Assumptions
- Organizations use departments for structure
- Each org operates as a separate isolated tenant
- Managers confirm task assignments (unless auto-assign is enabled)
- Staff maintain their own availability
- Only verified certifications count toward eligibility
- Users access the system online (web only)

### Constraints
- Web application only (no native mobile)
- Stripe sandbox only (no real payments)
- One-way calendar support only
- No payroll, HR management, or enterprise compliance
- FYP timeline limits scope

---

## 9. Out of Scope

- Native mobile applications
- Payroll processing
- Two-way calendar synchronization
- Enterprise-level compliance certification
- Full HR management features
- Live commercial payment processing
- Advanced billing automation (recurring billing, invoices, refunds, tax, proration)

---

## 10. Development Phases

| Phase | Focus |
|---|---|
| 1 | Foundation, public website, authentication |
| 2 | Registration, Stripe checkout, organization management |
| 3 | RBAC, company settings, eligibility rules |
| 4 | Task management |
| 5 | Eligibility engine + staff suggestions |
| 6 | Task allocation + staff workflow (assign, withdraw, clock, complete) |
| 7 | Notifications, calendar, audit logs, dashboard summaries |
| 8 | Testing, polish, deployment |

---

## 11. Current Implementation Status

### ✅ Completed
- Landing page
- Full authentication suite (login, register, verify email, reset password, accept invitation)
- Organization onboarding with industry templates
- Department management (CRUD)
- Member management (invite, CSV import, role/dept assignment, activate/deactivate)
- RBAC with custom roles and permissions
- Task creation/management (including recurring patterns, NL parsing)
- Smart staff suggestions + auto-schedule
- Availability management (weekly + date-specific overrides)
- Certification management (submit, verify, reject)
- Time tracking (clock in/out)
- Notifications (inbox, mark read, unread count)
- Audit logs
- Calendar view with coverage
- Work rules / eligibility rules
- Company settings
- Platform admin (tenants, metrics)
- Role-specific dashboards with AI insights
- Subscription tier enforcement (limits + feature gating)
- Stripe integration (package installed, schema has Stripe fields)

### 🔲 Remaining
- Stripe checkout session + webhook handlers (flow not wired)
- Staff task withdrawal request (dedicated flow)
- Mark task as completed endpoint
- Eligibility warning UI during assignment
- System-triggered notifications (assignment, overdue, hour-limit)
- Recurring task instance generation (scheduler)
- Subscription upgrade/downgrade UI
- Task issue alerts page
- Manager clock-time adjustment
- iCal feed endpoint
- Certification expiry scheduled notifications


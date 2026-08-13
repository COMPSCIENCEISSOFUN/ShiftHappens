# ShiftHappens

A SaaS platform for intelligent workforce management in shift-based industries (hospitality, retail, healthcare). Features AI-powered staff allocation, an eligibility engine, projects, and real-time scheduling.

**Project:** CSIT321 Final Year Project — University of Wollongong (SIM Campus)  
**Team:** FYP-26-S2-22

> Formerly "Smart Task Allocation". The database name `smart_task_allocation` is
> unchanged throughout this guide — renaming it would invalidate every existing
> `.env` file and migration history for no benefit.

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js (App Router) | 16.2.6 |
| Language | TypeScript | 5.x |
| Styling | Tailwind CSS + shadcn/ui | 4.x |
| Database | PostgreSQL | 17+ |
| ORM | Prisma | 6.19.3 |
| Auth | NextAuth.js v5 | 5.0.0-beta.31 |
| Email | Nodemailer (Gmail SMTP) or Resend | 7.x / 6.12.3 |
| Payments | Stripe (Checkout + webhooks) | — |
| Spreadsheets | SheetJS (`xlsx`) | 0.18.5 |
| AI | Groq + Google Gemini | Strategy pattern |
| Testing | Vitest | 4.1.6 |

---

## Prerequisites

Before you begin, make sure you have these installed:

- **Node.js** v22+ — [Download](https://nodejs.org/)
- **npm** v11+ (comes with Node.js)
- **PostgreSQL** 17+ — [Download](https://www.postgresql.org/download/)
- **Git** — [Download](https://git-scm.com/)

---

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/nvliteesm/ShiftHappens.git
cd ShiftHappens
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up PostgreSQL databases

Open a terminal and create two databases — one for development, one for testing:

```bash
psql -U postgres -c "CREATE DATABASE smart_task_allocation;"
psql -U postgres -c "CREATE DATABASE smart_task_allocation_test;"
```

You'll be prompted for your PostgreSQL password.

### 4. Create environment files

Create three files in the project root:

**`.env`** — Used by Prisma CLI:
```env
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/smart_task_allocation"
```

**`.env.local`** — Used by the dev server:
```env
# Database
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/smart_task_allocation"

# NextAuth
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="generate-a-random-secret-here"

# Email — Gmail SMTP (preferred) OR Resend. See "Email setup" below.
# Whichever is configured wins; Gmail takes precedence when both are present.
GMAIL_USER="youraccount@gmail.com"
GMAIL_APP_PASSWORD="your-16-char-app-password"

# Resend — only delivers to the account owner until a DOMAIN is verified.
RESEND_API_KEY="re_your_resend_api_key"
RESEND_FROM_EMAIL="onboarding@resend.dev"

# Stripe (billing). Test keys are fine for development.
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."

# AI Providers
GROQ_API_KEY="gsk_your_groq_api_key"
GEMINI_API_KEY="your_gemini_api_key"
AI_PROVIDER="groq"

# Scheduled jobs (recurring-task generation + hour-limit alerts)
# Shared secret the cron caller must present as `Authorization: Bearer <value>`.
CRON_SECRET="generate-a-random-secret-here"
```

> **Deploying?** `NEXTAUTH_URL` must be the deployed origin, not `localhost`.
> Every verification and invitation link is built from it, so a stale value
> sends working emails carrying dead links.

**`.env.test`** — Used by tests:
```env
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/smart_task_allocation_test"
```

> **Note:** Replace `YOUR_PASSWORD` with your PostgreSQL password. If your password contains special characters like `@`, the `.env` files handle them correctly — do not URL-encode them.

To generate a NextAuth secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 5. Run database migrations

Apply migrations to both databases:

```bash
# Dev database
npx prisma migrate dev

# Test database
set DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/smart_task_allocation_test
npx prisma migrate deploy
set DATABASE_URL=
```

> **Important (Windows):** Always run `set DATABASE_URL=` after test database operations to clear the environment variable.

### 6. Seed the database

Seed permissions (required for RBAC):
```bash
npx prisma db seed
```

Seed demo data (optional — creates sample org with staff, tasks, and certifications):
```bash
npx tsx prisma/seed-demo.ts
```

Also seed the test database:
```bash
set DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/smart_task_allocation_test
npx prisma db seed
set DATABASE_URL=
```

### 7. Start the development server

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000)

---

## Demo Accounts

If you ran the demo seed script, these accounts are available:

| Role | Email | Password |
|------|-------|----------|
| Company Admin | admin@oceangrill.com | TestPass1! |
| Manager (Kitchen) | sarah@oceangrill.com | TestPass1! |
| Manager (Bar) | marcus@oceangrill.com | TestPass1! |
| Staff | alex@oceangrill.com | TestPass1! |
| Staff | jamie@oceangrill.com | TestPass1! |
| Staff | taylor@oceangrill.com | TestPass1! |
| Staff | jordan@oceangrill.com | TestPass1! |
| Staff | casey@oceangrill.com | TestPass1! |

---

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server on localhost:3000 |
| `npm test` | Run all tests (uses test database) |
| `npm run build` | Production build check |
| `npm run lint` | ESLint check |
| `npx prisma studio` | Visual database browser on localhost:5555 |
| `npx prisma migrate dev --name <name>` | Create new migration |
| `npx prisma db seed` | Seed permissions |
| `npx tsx prisma/seed-demo.ts` | Seed demo data |

---

## Project Architecture

This project follows the **BCE (Boundary-Control-Entity)** architecture pattern:

```
Boundary (Pages, API Routes)
    ↓
Control (Services — business logic)
    ↓
Entity (Repositories — data access)
    ↓
Database (PostgreSQL via Prisma)
```

- **Boundary** never directly accesses Entity
- Every request flows through the Control layer
- All database queries are org-scoped for multi-tenant isolation

### Directory Structure

```
src/
├── app/                    # Next.js pages and API routes (Boundary)
│   ├── (auth)/             # Auth pages (login, register, etc.)
│   ├── (app)/              # Authenticated pages with sidebar
│   └── api/                # API route handlers
├── services/               # Business logic (Control)
├── repositories/           # Data access (Entity)
├── components/             # UI components
└── lib/                    # Shared utilities (auth, prisma, validations)

tests/
├── helpers/                # Shared test utilities
├── repositories/           # Repository tests
├── services/               # Service tests
└── lib/                    # Validation tests
```

---

## Features

### Phase 1 — Authentication
- Register, login, logout
- Email verification via Resend
- Password reset flow
- Profile management

### Phase 2 — Organization Management
- Multi-tenant organizations
- Department CRUD with color coding
- User invitation system (7-day token expiry)
- Member role management (Company Admin / Manager / Staff)
- Activate/deactivate members

### Phase 3 — RBAC & Settings
- 34 granular permissions across 10 categories
- Custom role creation with permission toggles
- Company settings (allocation mode, break rules, notifications)

### Phase 4 — Task Management
- Task CRUD with scheduling, priority, and headcount
- Staff assignment with conflict detection
- Accept/reject assignments with reasons
- Clock in/out time tracking
- Task lifecycle (open → in_progress → completed → cancelled)

### Phase 5 — Smart Allocation
- Three-dimensional eligibility engine (hours, availability, scheduling)
- Weekly availability schedules with date overrides
- Certification management (submit, verify, reject)
- AI-powered staff ranking via Groq with Gemini failover
- Weighted algorithmic fallback when AI is unavailable
- Two allocation modes: suggested (engine ranks, a human decides) and auto
  (engine offers the shift; the person still accepts)

### Phase 6 — Billing & Plans
- Stripe Checkout for Pro and Enterprise, monthly or annual
- Tier applied by webhook, with a second path on return from checkout so an
  upgrade appears even when the webhook has not arrived
- Per-resource plan limits (members, tasks, departments, work rules, custom
  roles, projects) enforced in the service layer, not just hidden in the UI
- Cancel schedules the end of the paid period and can be resumed

### Phase 7 — Projects
- Group related work items under one outcome, with progress and staffing
  derived from the linked tasks
- Open participation or a private Project Team
- Deleting a project keeps its work items as ordinary tasks

### Phase 8 — Invitations & Onboarding
- Email invitations with a 7-day token; revoke a pending one at any time
- Bulk invite from a spreadsheet, with the format stated before upload, a
  downloadable template, alias matching, and AI for what the aliases miss
- Every row previewed with per-row validation before anything is sent

### Phase 9 — Feedback, Reviews & Platform Admin
- In-app feedback and customer reviews, moderated by a platform admin
- Platform dashboard with MRR, growth against the previous 30 days, paid
  conversion, task completion rate and payment failures

---

## AI Integration

The platform uses AI to rank eligible staff for task assignments. The system uses a **Strategy pattern** with automatic failover:

1. **Primary:** Groq (Llama 3.1) — fast, free tier
2. **Fallback:** Google Gemini — generous free tier
3. **Algorithmic:** Weighted multi-factor scoring (if both AI providers fail)

The algorithmic fallback scores candidates across four dimensions:
- Hours utilization (30%) — fewer hours = higher score
- Availability fit (25%) — tighter match = higher score
- Certifications (25%) — more relevant certs = higher score
- Department experience (20%) — more history = higher score

To switch AI providers, set `AI_PROVIDER` in `.env.local`:
```env
AI_PROVIDER="groq"    # default
AI_PROVIDER="gemini"  # backup
```

---

## Scheduled Jobs (Cron)

Two background jobs keep the platform current across all active organizations:

- **Recurring-task generation** — materialises upcoming instances of recurring series so future shifts keep appearing.
- **Hour-limit alert scan** — notifies at-risk staff and their managers as hours approach/exceed a limit.

Both run via a single endpoint, `GET /api/cron`, which fans the work out across every active org. The endpoint is **not** protected by a user session — the caller must present a shared secret:

```
Authorization: Bearer <CRON_SECRET>
```

Set `CRON_SECRET` in the environment. If it is unset, the endpoint rejects every request (fail-closed). Both jobs are idempotent and cooldown-guarded, so repeat calls are safe.

### Option A — Vercel Cron (default)
`vercel.json` schedules the endpoint hourly:
```json
{ "crons": [{ "path": "/api/cron", "schedule": "0 * * * *" }] }
```
Set `CRON_SECRET` in the Vercel project env — Vercel Cron automatically sends it as the `Authorization: Bearer` header. (Note: the Vercel Hobby tier limits crons to once per day; adjust the schedule accordingly.)

### Option B — GitHub Actions
`.github/workflows/scheduled-jobs.yml` curls the endpoint on a schedule. Add repository secrets `APP_URL` and `CRON_SECRET`.

### Trigger manually (local/testing)
```bash
curl -H "Authorization: Bearer %CRON_SECRET%" http://localhost:3000/api/cron
```

---

## API Keys Setup

### Email — pick one

The app sends verification, password-reset and invitation mail. It supports two
providers and picks whichever is configured, preferring Gmail when both are:

**Gmail SMTP (recommended for development).** Free, needs no domain, and
delivers to anybody. Roughly 500 messages a day.

1. On the Google account, turn on **2-Step Verification**
2. Search the account settings for **App passwords** and generate one
3. Put the account address in `GMAIL_USER` and the 16-character code in
   `GMAIL_APP_PASSWORD`

**Resend.** Better deliverability and a real sender name, but it will only
deliver to your own account address until you verify a **domain** you own —
which means owning one. Set `RESEND_API_KEY` and point `RESEND_FROM_EMAIL` at
an address on the verified domain.

To switch from Gmail back to Resend, remove the two `GMAIL_*` variables; no code
change is needed.

### Stripe (Billing)

1. Create an account at [stripe.com](https://stripe.com) and stay in **test
   mode** — no real money moves
2. Copy the secret key into `STRIPE_SECRET_KEY`
3. For webhooks locally, install the Stripe CLI and run:
   ```bash
   stripe listen --forward-to localhost:3000/api/webhooks/stripe
   ```
   It prints a signing secret for `STRIPE_WEBHOOK_SECRET`

Stripe cannot reach `localhost` on its own, so without the CLI the webhook never
arrives. The app also reconciles on return from Checkout, so an upgrade still
appears — but the CLI is what exercises the real path.

### Groq (AI — Required for smart allocation)
1. Go to [console.groq.com](https://console.groq.com)
2. Sign up (free, no credit card)
3. Create an API key
4. Add to `.env.local` as `GROQ_API_KEY`

### Google Gemini (AI — Backup)
1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Sign in with Google
3. Get an API key
4. Add to `.env.local` as `GEMINI_API_KEY`

### Resend (Email)
1. Go to [resend.com](https://resend.com)
2. Sign up (free, no credit card)
3. Create an API key
4. Add to `.env.local` as `RESEND_API_KEY`

> **Note:** With `onboarding@resend.dev`, emails can only be sent to the email address you registered with on Resend. To send to any address, verify a custom domain in Resend.

---

## Testing

Tests use a separate database (`smart_task_allocation_test`) to prevent dev data loss.

```bash
# Run all tests
npm test

# Run a specific test file
npm test -- tests/services/task.service.test.ts

# Run tests matching a pattern
npm test -- --grep "eligibility"
```

Current: **322 tests, 28 test files, all passing.**

---

## Troubleshooting

### "Database does not exist"
Create the databases:
```bash
psql -U postgres -c "CREATE DATABASE smart_task_allocation;"
psql -U postgres -c "CREATE DATABASE smart_task_allocation_test;"
```

### Tests failing with foreign key errors
The `cleanDatabase()` helper in `tests/helpers/cleanup.ts` handles deletion order. If you add new tables with foreign keys, update this file.

### Dev server connecting to wrong database
Check for a lingering environment variable:
```bash
echo %DATABASE_URL%
```
If it shows the test database URL, clear it:
```bash
set DATABASE_URL=
```

### Prisma client types not recognized
Regenerate the client:
```bash
npx prisma generate
```
Then restart VS Code's TypeScript server: `Ctrl+Shift+P` → "TypeScript: Restart TS Server"

### Email not sending
- **Restart the dev server.** Node reads `.env.local` once at boot, so newly
  added credentials are not picked up by a running process.
- Check the terminal for `[Email Error]` lines — they name the provider and the
  reason.
- **Gmail:** `GMAIL_APP_PASSWORD` must be a Google *App Password*, not the
  account password, and 2-Step Verification has to be on before Google will
  issue one. Spaces in it are stripped automatically.
- **Resend:** with `onboarding@resend.dev` you can only send to your own Resend
  account address. Anyone else needs a verified domain.
- `[Email Error] … no email provider configured` means neither pair of
  variables is set.

---

## Contributing

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Follow BCE architecture — services for logic, repositories for data
3. Write tests for all new services and repositories
4. Run `npm test` and `npm run build` before committing
5. Use descriptive commit messages: `feat:`, `fix:`, `refactor:`

---

## License

This project is part of CSIT321 Final Year Project at the University of Wollongong (SIM Campus). All rights reserved.

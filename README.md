# ShiftHappens

A SaaS platform for intelligent workforce management in shift-based industries (hospitality, retail, healthcare). Features AI-powered staff allocation, eligibility engine, and real-time scheduling.

**Project:** CSIT321 Final Year Project — University of Wollongong (SIM Campus)  
**Team:** CSIT-26-S2-04

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js (App Router) | 16.3.0 |
| Language | TypeScript | 5.x |
| Styling | Tailwind CSS + shadcn/ui | 4.x |
| Database | PostgreSQL | 17+ |
| ORM | Prisma | 6.19.3 |
| Auth | NextAuth.js v5 | 5.0.0-beta.32 |
| Email | Resend | 6.12.3 |
| AI | Groq + Google Gemini | Strategy pattern |
| Testing | Vitest | 4.1.10 |

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

# Resend (Email)
RESEND_API_KEY="re_your_resend_api_key"
RESEND_FROM_EMAIL="onboarding@resend.dev"

# AI Providers
GROQ_API_KEY="gsk_your_groq_api_key"
GEMINI_API_KEY="your_gemini_api_key"
AI_PROVIDER="groq"

# Scheduled jobs (recurring-task generation + hour-limit alerts)
# Shared secret the cron caller must present as `Authorization: Bearer <value>`.
CRON_SECRET="generate-a-random-secret-here"
```

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

### Project-based IT demo

Run `npm exec -- tsx prisma/seed-it-demo.ts` to create the Northstar IT Solutions demo organisation.

| Role | Email | Password | Scope |
|------|-------|----------|-------|
| Company Admin | admin@northstarit.com | TestPass1! | All departments |
| Manager | priya@northstarit.com | TestPass1! | Product Engineering + Client Delivery |
| Manager | daniel@northstarit.com | TestPass1! | Cloud & DevOps |
| Staff | maya@northstarit.com | TestPass1! | Product Engineering |
| Staff | leo@northstarit.com | TestPass1! | Product Engineering + Client Delivery |
| Staff | sophia@northstarit.com | TestPass1! | Cloud & DevOps |
| Staff | ethan@northstarit.com | TestPass1! | Cloud & DevOps + Security & QA |
| Staff | nora@northstarit.com | TestPass1! | Client Delivery |
| Staff | oliver@northstarit.com | TestPass1! | Security & QA |
| Staff | ava@northstarit.com | TestPass1! | Product Engineering + Security & QA |

---

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server on localhost:3000 |
| `npm test` | Run all tests (uses test database) |
| `npm run test:utc` | Re-run timezone-sensitive coverage under production UTC |
| `npm run build` | Production build check |
| `npm run lint` | ESLint check |
| `npx prisma studio` | Visual database browser on localhost:5555 |
| `npx prisma migrate dev --name <name>` | Create new migration |
| `npx prisma db seed` | Seed permissions |
| `npx tsx prisma/seed-demo.ts` | Seed demo data |

Pull requests and pushes to `main` run migrations, seed RBAC data, typecheck,
lint, both test modes, and a production build in GitHub Actions. Do not merge a
change with a failing CI check. The scheduled-job workflow additionally needs
`APP_URL` and `CRON_SECRET` repository secrets.

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
- AI-assisted staff assignment with conflict detection
- Automatic assignment lifecycle with manager-reviewed withdrawal exceptions
- Clock in/out time tracking
- Task lifecycle (open → in_progress → completed → cancelled)

### Phase 5 — Smart Allocation
- Three-dimensional eligibility engine (hours, availability, scheduling)
- Weekly availability schedules with date overrides
- Certification management (submit, verify, reject)
- AI-powered staff ranking via Groq with Gemini failover
- Weighted algorithmic fallback when AI is unavailable
- Two allocation modes: auto (default) and manual, with AI staff ranking available in both

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
- Check `RESEND_API_KEY` is set in `.env.local`
- With `onboarding@resend.dev`, you can only send to your own Resend account email
- Check the terminal for `[Email Error]` messages

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

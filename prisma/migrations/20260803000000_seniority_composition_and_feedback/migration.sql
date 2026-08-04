-- Seniority, composition constraints, response timing and satisfaction.
--
-- One migration rather than three, because all three land in the same working
-- session and every schema change on this project has to be hand-carried to
-- Supabase (migration history is not baselined — see claude/BACKLOG.md §5).
-- Three separate hand-runs is three chances to run two of them.
--
-- Safe against a live database. Every added column is either nullable or has a
-- default, and Postgres adds both without rewriting the table. Nothing is
-- dropped, renamed or backfilled, so the deployed application keeps working
-- between this running and the new code shipping.

-- ---------------------------------------------------------------------------
-- Membership: manual seniority override
-- ---------------------------------------------------------------------------
-- NULL means "derive from completed shifts", which is the normal state. It
-- deliberately has no default: 'junior' as a default would turn every member
-- who has never been reviewed into an explicit managerial judgement that
-- nobody made, and derived seniority could then never correct itself.
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "seniorityOverride" TEXT;

-- ---------------------------------------------------------------------------
-- CompanySettings: the thresholds seniority is derived against
-- ---------------------------------------------------------------------------
-- Defaults chosen to be defensible rather than precise: ten completed shifts
-- is roughly "has seen the usual problems once", forty is "has seen the
-- unusual ones". Any organisation for which that is wrong can change it, which
-- is the point of the columns existing at all.
ALTER TABLE "CompanySettings"
  ADD COLUMN IF NOT EXISTS "experiencedShiftThreshold" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "CompanySettings"
  ADD COLUMN IF NOT EXISTS "seniorShiftThreshold" INTEGER NOT NULL DEFAULT 40;

-- ---------------------------------------------------------------------------
-- Task: composition rules
-- ---------------------------------------------------------------------------
-- JSON text, following the existing recurringPattern column rather than
-- introducing jsonb for one field. Validated by Zod on the way in and parsed
-- defensively on the way out, so a malformed value degrades to "no rules"
-- instead of breaking the task.
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "compositionRules" TEXT;

-- ---------------------------------------------------------------------------
-- TaskAssignment: response timing
-- ---------------------------------------------------------------------------
-- Not backfilled. updatedAt on an existing row is the time of its LAST
-- transition, not its response, so copying it across would manufacture
-- plausible-looking history that is wrong — a shift accepted in June and
-- completed in July would report a six-week response time. Existing rows
-- stay NULL and are counted as "no response recorded".
ALTER TABLE "TaskAssignment" ADD COLUMN IF NOT EXISTS "acceptedAt" TIMESTAMP(3);
ALTER TABLE "TaskAssignment" ADD COLUMN IF NOT EXISTS "rejectedAt" TIMESTAMP(3);
ALTER TABLE "TaskAssignment" ADD COLUMN IF NOT EXISTS "withdrawalRequestedAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- TaskAssignment: satisfaction
-- ---------------------------------------------------------------------------
-- The 1–5 bound is enforced in Zod at the API boundary and again here. The
-- database constraint is the one that survives a bad migration script, a
-- direct psql session, or a future endpoint that forgets to validate.
ALTER TABLE "TaskAssignment" ADD COLUMN IF NOT EXISTS "satisfactionRating" INTEGER;
ALTER TABLE "TaskAssignment" ADD COLUMN IF NOT EXISTS "satisfactionComment" TEXT;
ALTER TABLE "TaskAssignment" ADD COLUMN IF NOT EXISTS "ratedAt" TIMESTAMP(3);

DO $$
BEGIN
  ALTER TABLE "TaskAssignment"
    ADD CONSTRAINT "TaskAssignment_satisfactionRating_range"
    CHECK ("satisfactionRating" IS NULL
           OR ("satisfactionRating" >= 1 AND "satisfactionRating" <= 5));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Rated shifts are a small subset of all assignments and every satisfaction
-- query filters on the rating being present. Partial index so it stays small.
CREATE INDEX IF NOT EXISTS "TaskAssignment_satisfactionRating_idx"
  ON "TaskAssignment" ("satisfactionRating")
  WHERE "satisfactionRating" IS NOT NULL;

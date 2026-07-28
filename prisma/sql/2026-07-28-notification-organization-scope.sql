-- ─────────────────────────────────────────────────────────────────────────────
-- Notification → organisation scoping
--
-- Adds Notification."organizationId" so a user who belongs to more than one
-- organisation gets one feed per organisation instead of a merged one.
--
-- WHERE TO RUN THIS
--   Supabase (production): paste into the SQL Editor. Do NOT use
--     `prisma db push` against the pooled connection — it hangs from
--     Singapore through PgBouncer (see the Phase 13 handover).
--   Local dev + test DBs: `npx prisma db push` is fine, or run this file.
--
-- The backfill attributes each existing notification to its user's
-- organisation where that is unambiguous. Rows belonging to a user who is in
-- zero organisations, or in two or more, cannot be attributed and are deleted:
-- a notification pointing at the wrong tenant is worse than a missing one, and
-- all current rows are demo data.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Add the column, nullable for now so the backfill can run.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- 2. Backfill: only where the user belongs to exactly one organisation.
UPDATE "Notification" n
SET "organizationId" = m."organizationId"
FROM "Membership" m
WHERE m."userId" = n."userId"
  AND n."organizationId" IS NULL
  AND (SELECT COUNT(*) FROM "Membership" m2 WHERE m2."userId" = n."userId") = 1;

-- 3. Drop what could not be attributed.
DELETE FROM "Notification" WHERE "organizationId" IS NULL;

-- 4. Enforce the invariant from here on.
ALTER TABLE "Notification" ALTER COLUMN "organizationId" SET NOT NULL;

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Replace the user-only indexes with org-aware ones.
--    Every read filters on (userId, organizationId), so a userId-only index
--    would leave the org predicate to a filter step on every query.
DROP INDEX IF EXISTS "Notification_userId_isRead_idx";
DROP INDEX IF EXISTS "Notification_userId_createdAt_idx";

CREATE INDEX IF NOT EXISTS "Notification_userId_organizationId_isRead_idx"
  ON "Notification"("userId", "organizationId", "isRead");
CREATE INDEX IF NOT EXISTS "Notification_userId_organizationId_createdAt_idx"
  ON "Notification"("userId", "organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_organizationId_idx"
  ON "Notification"("organizationId");

COMMIT;

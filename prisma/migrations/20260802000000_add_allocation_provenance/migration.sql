-- Allocation provenance on TaskAssignment.
--
-- All four columns are nullable on purpose. Every assignment that already
-- exists predates the engine recording anything, and NULL has to stay
-- distinguishable from "manual" — defaulting to 'manual' would silently
-- claim a human made every historical decision.
--
-- Safe to run against a live database: adding nullable columns takes no
-- table rewrite in Postgres, and the index is the only part that touches
-- existing rows.
ALTER TABLE "TaskAssignment" ADD COLUMN IF NOT EXISTS "allocationSource" TEXT;
ALTER TABLE "TaskAssignment" ADD COLUMN IF NOT EXISTS "allocationProvider" TEXT;
ALTER TABLE "TaskAssignment" ADD COLUMN IF NOT EXISTS "allocationScore" DOUBLE PRECISION;
ALTER TABLE "TaskAssignment" ADD COLUMN IF NOT EXISTS "allocationRank" INTEGER;

CREATE INDEX IF NOT EXISTS "TaskAssignment_allocationSource_createdAt_idx"
  ON "TaskAssignment" ("allocationSource", "createdAt");

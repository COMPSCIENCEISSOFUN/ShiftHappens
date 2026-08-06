-- Leave requests: approval state on AvailabilityOverride.
--
-- WHY THE DEFAULT IS 'approved'
--
-- The row means different things depending on who wrote it. A CASUAL member's
-- availability is an offer — theirs to give and take back — so their overrides
-- take effect immediately, exactly as every override did before this column
-- existed. A FULL-TIME member is contracted, so an absence is a leave request:
-- written 'pending' and ignored by the roster until a manager approves it.
--
-- Every row that already exists belonged to the old, immediate behaviour.
-- Backfilling them to 'pending' would retroactively put people back onto shifts
-- they had already been excused from, so the default has to be 'approved' and
-- the migration must not touch existing rows.
--
-- SAFE TO RE-RUN. Every statement is IF NOT EXISTS, because the migration
-- history is not baselined on any of the three databases and this is applied by
-- hand — see claude/BACKLOG.md §5.

ALTER TABLE "AvailabilityOverride"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'approved';

ALTER TABLE "AvailabilityOverride"
  ADD COLUMN IF NOT EXISTS "reviewedById" TEXT;

-- SetNull, not Cascade: who approved a leave request is a fact about the
-- request, and deleting the reviewer's account must not delete the leave with
-- it. The absence still happened.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'AvailabilityOverride_reviewedById_fkey'
  ) THEN
    ALTER TABLE "AvailabilityOverride"
      ADD CONSTRAINT "AvailabilityOverride_reviewedById_fkey"
      FOREIGN KEY ("reviewedById") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "AvailabilityOverride_status_idx"
  ON "AvailabilityOverride"("status");

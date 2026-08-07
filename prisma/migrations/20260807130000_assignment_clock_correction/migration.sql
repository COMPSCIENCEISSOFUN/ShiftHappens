-- Let a manager correct a recorded clock time.
--
-- A shift clocked into and never out of contributes no hours, and nobody could
-- amend it: the member's own history said the shift was not counted and offered
-- no route to fixing it. Three nullable columns, so no backfill and no default.
--
-- The FACT of a correction lives on the row, so a member sees it on their own
-- history without needing the audit-log screen their plan may not include. The
-- BEFORE and AFTER values live in the audit row instead — a value somebody can
-- quietly restate is not evidence, and the point of a correction is that the
-- correction is visible rather than that the original disappears.
--
-- No foreign key on clockCorrectedById, matching assignedById on the same
-- table: a deactivated user must not cascade away the record of what they did.
--
-- IF NOT EXISTS so the file is safe to run twice.
ALTER TABLE "TaskAssignment"
  ADD COLUMN IF NOT EXISTS "clockCorrectedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "clockCorrectedById" TEXT,
  ADD COLUMN IF NOT EXISTS "clockCorrectionReason" TEXT;

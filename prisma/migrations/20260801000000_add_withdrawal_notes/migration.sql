-- Optional free text alongside a structured withdrawal reason.
--
-- Withdrawal reasons became one of the eight DECLINE_REASONS values so they can
-- be counted; this column preserves what the previous free-text field was good
-- for, since "personal_reasons" on its own tells the approving manager nothing.
--
-- IF NOT EXISTS so the statement is safe to re-run against a database that was
-- brought up with `prisma db push` rather than through migration history.
ALTER TABLE "TaskAssignment" ADD COLUMN IF NOT EXISTS "withdrawalNotes" TEXT;

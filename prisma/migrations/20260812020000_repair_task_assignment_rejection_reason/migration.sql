-- Repair databases where the initial TaskAssignment migration was recorded
-- without creating this nullable lifecycle field.
ALTER TABLE "TaskAssignment"
ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT;

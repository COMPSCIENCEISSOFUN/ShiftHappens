-- Leave reminder tracking.
--
-- `submittedAt` is the review clock. It cannot be `createdAt` (the upsert that
-- re-opens a declined request must restart it) nor `updatedAt` (writing
-- `remindedAt` would reset the very clock the reminder was measured against).
--
-- `remindedAt` / `escalatedAt` record that a chase went out. They are not
-- derivable from the notification log, which writes nothing at all when an
-- organisation has that notification type disabled.
ALTER TABLE "AvailabilityOverride" ADD COLUMN "submittedAt" TIMESTAMP(3);
ALTER TABLE "AvailabilityOverride" ADD COLUMN "remindedAt" TIMESTAMP(3);
ALTER TABLE "AvailabilityOverride" ADD COLUMN "escalatedAt" TIMESTAMP(3);
-- Its own mark: a request that lapses has usually been chased already, so
-- `remindedAt` is taken. Different recipient, different question.
ALTER TABLE "AvailabilityOverride" ADD COLUMN "lapseNotifiedAt" TIMESTAMP(3);

-- Existing rows: the clock starts when they were created. Backfilling to NULL
-- would leave every historic pending request permanently un-chaseable; using
-- `createdAt` makes any that are still open overdue at once, which is correct —
-- they have been waiting the longest.
UPDATE "AvailabilityOverride" SET "submittedAt" = "createdAt" WHERE "submittedAt" IS NULL;

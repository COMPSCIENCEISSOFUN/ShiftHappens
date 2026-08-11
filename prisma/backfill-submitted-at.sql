-- Backfill the review clock for requests written before the column existed.
--
-- Run with:
--   npx prisma db execute --file ./prisma/backfill-submitted-at.sql --schema ./prisma/schema.prisma
--
-- Safe to run more than once: the WHERE clause makes it a no-op the second time.
--
-- `createdAt` is the honest seed. Any of these still pending have been waiting
-- longest, so making them immediately overdue is the correct answer rather than
-- a convenient one. Without it they carry no clock at all and only the horizon
-- half of the rule can ever fire for them.
UPDATE "AvailabilityOverride"
SET "submittedAt" = "createdAt"
WHERE "submittedAt" IS NULL;

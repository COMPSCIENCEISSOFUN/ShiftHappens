-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "organizationId" TEXT;

-- Backfill: attribute each existing notification to its user's organisation,
-- where that user belongs to exactly one. Rows that cannot be attributed
-- (user in zero or multiple orgs) are removed — a notification rendered under
-- the wrong tenant is worse than a missing one.
UPDATE "Notification" n
SET "organizationId" = m."organizationId"
FROM "Membership" m
WHERE m."userId" = n."userId"
  AND n."organizationId" IS NULL
  AND (SELECT COUNT(*) FROM "Membership" m2 WHERE m2."userId" = n."userId") = 1;

DELETE FROM "Notification" WHERE "organizationId" IS NULL;

ALTER TABLE "Notification" ALTER COLUMN "organizationId" SET NOT NULL;

-- DropIndex
DROP INDEX "Notification_userId_isRead_idx";
DROP INDEX "Notification_userId_createdAt_idx";

-- CreateIndex
CREATE INDEX "Notification_userId_organizationId_isRead_idx" ON "Notification"("userId", "organizationId", "isRead");

-- CreateIndex
CREATE INDEX "Notification_userId_organizationId_createdAt_idx" ON "Notification"("userId", "organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_organizationId_idx" ON "Notification"("organizationId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

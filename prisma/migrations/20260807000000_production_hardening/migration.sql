-- Session invalidation for privilege changes and password resets.
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- Preserve cancellation metadata instead of deleting assignment history.
ALTER TABLE "TaskAssignment"
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledById" TEXT,
  ADD COLUMN "cancellationReason" TEXT;

-- Overrides are temporary and can be revoked without erasing their audit trail.
ALTER TABLE "EligibilityOverride"
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "revokedAt" TIMESTAMP(3);

CREATE INDEX "EligibilityOverride_taskId_membershipId_revokedAt_idx"
  ON "EligibilityOverride"("taskId", "membershipId", "revokedAt");

-- Keep invitation history while preventing concurrent duplicate pending invites.
-- Expired pending records are removed by the invitation service before issuing a
-- replacement, so this index remains the final concurrency guard.
CREATE UNIQUE INDEX "InvitationToken_pending_org_email_key"
  ON "InvitationToken"("organizationId", lower("email"))
  WHERE "acceptedAt" IS NULL;

ALTER TABLE "InvitationToken"
  ADD COLUMN "emailDeliveryStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "emailDeliveryError" TEXT,
  ADD COLUMN "emailSentAt" TIMESTAMP(3);

-- A member may have several non-overlapping windows on the same weekday.
DROP INDEX IF EXISTS "Availability_membershipId_dayOfWeek_key";
CREATE INDEX "Availability_membershipId_dayOfWeek_idx"
  ON "Availability"("membershipId", "dayOfWeek");

CREATE TABLE "AssistantOperation" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'completed',
  "undoPayload" JSONB,
  "expiresAt" TIMESTAMP(3),
  "undoneAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantOperation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AssistantOperation_organizationId_userId_createdAt_idx"
  ON "AssistantOperation"("organizationId", "userId", "createdAt");

ALTER TABLE "AssistantOperation"
  ADD CONSTRAINT "AssistantOperation_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssistantOperation"
  ADD CONSTRAINT "AssistantOperation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContactSubmission" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "company" TEXT,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'new',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactSubmission_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContactSubmission_status_createdAt_idx"
  ON "ContactSubmission"("status", "createdAt");
CREATE INDEX "ContactSubmission_email_createdAt_idx"
  ON "ContactSubmission"("email", "createdAt");

ALTER TABLE "ContactSubmission"
  ADD CONSTRAINT "ContactSubmission_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RateLimitBucket" (
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "RateLimitBucket_expiresAt_idx" ON "RateLimitBucket"("expiresAt");

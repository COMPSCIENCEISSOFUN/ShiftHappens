-- Questions asked from the landing page or from inside the app.
--
-- Both owner columns are nullable and both foreign keys are SET NULL rather
-- than CASCADE: a question outlives the account that asked it. A visitor has no
-- account at all, and a customer who leaves does not un-ask the thing that made
-- the FAQ entry worth writing.
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "membershipId" TEXT,
    "organizationId" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Question_handledAt_createdAt_idx" ON "Question"("handledAt", "createdAt");

ALTER TABLE "Question" ADD CONSTRAINT "Question_membershipId_fkey"
    FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Question" ADD CONSTRAINT "Question_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

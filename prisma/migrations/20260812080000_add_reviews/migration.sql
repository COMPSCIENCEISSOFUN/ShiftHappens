-- A customer's standing opinion, for the public landing page.
--
-- membershipId is UNIQUE: one review per person, updated rather than appended.
-- Enforcing it here rather than in a service means a second submission cannot
-- slip through a race between the check and the write.
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Review_membershipId_key" ON "Review"("membershipId");
CREATE INDEX "Review_status_updatedAt_idx" ON "Review"("status", "updatedAt");

ALTER TABLE "Review" ADD CONSTRAINT "Review_membershipId_fkey"
    FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

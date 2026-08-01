ALTER TABLE "TaskAssignment"
  ADD COLUMN IF NOT EXISTS "withdrawalRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "withdrawalReviewedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "withdrawalReviewedById" TEXT,
  ADD COLUMN IF NOT EXISTS "withdrawalDecision" TEXT,
  ADD COLUMN IF NOT EXISTS "withdrawalStatusBeforeRequest" TEXT;

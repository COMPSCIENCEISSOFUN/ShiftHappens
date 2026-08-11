-- Older databases can have the initial TaskAssignment migration recorded but
-- lack later nullable lifecycle columns. Each addition is safe to reapply.
ALTER TABLE "TaskAssignment"
  ADD COLUMN IF NOT EXISTS "rejectionNotes" TEXT,
  ADD COLUMN IF NOT EXISTS "withdrawalReason" TEXT,
  ADD COLUMN IF NOT EXISTS "withdrawalNotes" TEXT,
  ADD COLUMN IF NOT EXISTS "allocationSource" TEXT,
  ADD COLUMN IF NOT EXISTS "allocationProvider" TEXT,
  ADD COLUMN IF NOT EXISTS "allocationScore" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "allocationRank" INTEGER,
  ADD COLUMN IF NOT EXISTS "acceptedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rejectedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "clockCorrectedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "clockCorrectedById" TEXT,
  ADD COLUMN IF NOT EXISTS "clockCorrectionReason" TEXT,
  ADD COLUMN IF NOT EXISTS "withdrawalRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "satisfactionRating" INTEGER,
  ADD COLUMN IF NOT EXISTS "satisfactionComment" TEXT,
  ADD COLUMN IF NOT EXISTS "ratedAt" TIMESTAMP(3);

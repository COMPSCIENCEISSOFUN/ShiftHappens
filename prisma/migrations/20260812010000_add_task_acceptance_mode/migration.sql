-- The original settings migration was marked applied in some existing test
-- databases without this column. Repair those databases idempotently.
ALTER TABLE "CompanySettings"
ADD COLUMN IF NOT EXISTS "taskAcceptanceMode" TEXT NOT NULL DEFAULT 'auto_accept';

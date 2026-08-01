-- Phase 1 workflow alignment:
-- - automatic allocation becomes the default organization setting
-- - assignment acceptance mode is removed
-- - live assignments are active immediately
UPDATE "CompanySettings"
SET "allocationMode" = 'auto'
WHERE "allocationMode" IN ('manual', 'suggested');

UPDATE "TaskAssignment"
SET "status" = CASE
  WHEN "status" IN ('pending', 'accepted') THEN 'assigned'
  WHEN "status" = 'rejected' THEN 'cancelled'
  ELSE "status"
END;

ALTER TABLE "CompanySettings"
  ALTER COLUMN "allocationMode" SET DEFAULT 'auto',
  DROP COLUMN "taskAcceptanceMode";

ALTER TABLE "TaskAssignment"
  ALTER COLUMN "status" SET DEFAULT 'assigned';

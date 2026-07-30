-- AlterTable
ALTER TABLE "Certification" ADD COLUMN "rejectionReason" TEXT,
ADD COLUMN "rejectionNotes" TEXT;

-- No change is needed for the new "revoked" status: Certification.status is a
-- plain TEXT column with no database enum, so the value is validated in Zod at
-- the boundary rather than by the schema.

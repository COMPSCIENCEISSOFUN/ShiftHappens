-- Preserve the old no-availability behavior while removing the obsolete value.
UPDATE "Membership"
SET "employmentType" = 'casual'
WHERE "employmentType" = 'full_time';

UPDATE "InvitationToken"
SET "employmentType" = 'casual'
WHERE "employmentType" = 'full_time';

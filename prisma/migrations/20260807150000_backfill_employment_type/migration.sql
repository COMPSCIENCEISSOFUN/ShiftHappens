-- Make a blank employment type say what the system already means by it.
--
-- NULL has always been read as "casual" — `DEFAULT_EMPLOYMENT_TYPE` and
-- `isFullTime()` both fall back to it. That was a fair default for rows created
-- before the field existed. It stopped being fair once it started deciding
-- somebody's working conditions: a casual sets their own availability and their
-- days off bind immediately, while a full-timer's days are set by the employer
-- and their leave is a request.
--
-- Managers were the ones it hurt. The invite form only asked about employment
-- type when the invitee was staff, so every manager invited through the app
-- arrived NULL — and therefore casual — which let a salaried duty manager untick
-- Wednesdays and be off every Wednesday with nobody told. That form now asks
-- anyone who can be rostered; this brings the existing rows into line.
--
-- Scoped to rosterable roles. A company admin cannot be put on a shift, so the
-- field has nothing to act on for them and writing a value would state a fact
-- nobody established.
--
-- Idempotent: re-running matches nothing.
UPDATE "Membership"
SET "employmentType" = 'casual'
WHERE "employmentType" IS NULL
  AND "role" IN ('staff', 'manager');

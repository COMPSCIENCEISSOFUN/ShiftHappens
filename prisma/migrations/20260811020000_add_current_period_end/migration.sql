-- The renewal date, or the date access drops on a cancelling subscription.
--
-- Written by the same webhook that already writes tier, status and interval.
-- Stored rather than fetched live: a billing screen that cannot render without
-- a Stripe round trip breaks when Stripe is slow, to show a date that changes
-- once a month.
ALTER TABLE "Organization" ADD COLUMN "currentPeriodEnd" TIMESTAMP(3);

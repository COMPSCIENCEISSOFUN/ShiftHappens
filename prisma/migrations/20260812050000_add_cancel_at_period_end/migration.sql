-- Whether a cancellation has been scheduled for the end of the paid period.
--
-- Cancelling does not revoke access immediately: the organisation has paid up
-- to currentPeriodEnd, and taking the plan away on click would remove time
-- already bought. That makes one date mean two opposite things — "renews on"
-- and "ends on" — and this column is what tells them apart on screen.
--
-- Written by the customer.subscription.updated webhook, like every other
-- billing column here.
ALTER TABLE "Organization" ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;

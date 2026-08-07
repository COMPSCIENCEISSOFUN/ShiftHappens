-- Track Stripe event ordering per organization and retain every processed
-- event id so Stripe retries cannot apply the same change twice.
ALTER TABLE "Organization" ADD COLUMN "stripeLastEventAt" TIMESTAMP(3);

CREATE TABLE "StripeWebhookEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "eventCreatedAt" TIMESTAMP(3) NOT NULL,
  "outcome" TEXT NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StripeWebhookEvent_organizationId_eventCreatedAt_idx"
  ON "StripeWebhookEvent"("organizationId", "eventCreatedAt");

ALTER TABLE "StripeWebhookEvent"
  ADD CONSTRAINT "StripeWebhookEvent_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

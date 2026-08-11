-- A subscribe URL for a calendar client.
--
-- The token is the whole credential: calendar clients poll on a timer and send
-- no session, so the secret has to be the address. One row per membership, so a
-- leaked URL exposes one person's rota; `kind` exists so a future team feed is
-- a row rather than another migration.
CREATE TABLE "CalendarFeed" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'personal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPolledAt" TIMESTAMP(3),

    CONSTRAINT "CalendarFeed_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CalendarFeed_token_key" ON "CalendarFeed"("token");
CREATE INDEX "CalendarFeed_token_idx" ON "CalendarFeed"("token");
CREATE UNIQUE INDEX "CalendarFeed_membershipId_kind_key" ON "CalendarFeed"("membershipId", "kind");

ALTER TABLE "CalendarFeed" ADD CONSTRAINT "CalendarFeed_membershipId_fkey"
    FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

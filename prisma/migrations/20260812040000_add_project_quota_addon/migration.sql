-- Extra projects bought on top of the tier's included allowance.
--
-- Added to the tier baseline at check time, never replacing it, so a plan
-- change still moves the floor. Defaults to 0 and is reset to 0 when the
-- subscription ends: the add-on is a recurring subscription item, and quota
-- that outlived the payments for it would make the Enterprise upgrade
-- pointless for anyone who ever bought a pack.
ALTER TABLE "Organization" ADD COLUMN "projectQuotaAddon" INTEGER NOT NULL DEFAULT 0;

-- Three allocation modes become two, and the default becomes "auto".
--
-- "manual" (assign with no help) and "suggested" (assign with the engine's
-- ranking offered) collapse into one mode, presented as "Manual". SUGGESTED is
-- the value kept: manual-with-suggestions is what the product wants its
-- unautomated mode to be, so removing "suggested" would have removed the
-- behaviour and kept only the label.
--
-- Every organisation created before today sits on "manual", because that was
-- the column default — so this UPDATE is not an edge case, it is all of them.
UPDATE "CompanySettings"
SET "allocationMode" = 'suggested'
WHERE "allocationMode" = 'manual';

-- New organisations get automation by default. Existing ones are deliberately
-- left where they are by the UPDATE above: flipping a live rota to automatic
-- assignment without being asked would start putting real people on real
-- shifts on somebody else's schedule.
ALTER TABLE "CompanySettings" ALTER COLUMN "allocationMode" SET DEFAULT 'auto';

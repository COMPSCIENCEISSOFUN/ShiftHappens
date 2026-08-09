-- The certificates an organisation recognises: one shared vocabulary for the
-- two screens that name a certificate.
--
-- `Certification.name` is typed by the staff member and
-- `Task.requiredCertifications` by the manager, and eligibility compares them
-- by lower-cased string equality. Nothing brought the two together, so a member
-- holding "Food Safety Level 2" was silently ineligible for a shift requiring
-- "Food Safety" — and told they were missing the certificate they hold.
--
-- ADD ONLY as far as existing columns go: nothing is altered, converted or
-- dropped, so applying this cannot lose anything.
--
-- The data step is at the bottom of this file rather than in a script beside
-- it. Filling the list from the names already in use has to happen once per
-- database, at the moment the table appears, and before anybody edits a task —
-- a shift requiring "Food Safety" cannot show that requirement until the name
-- is listed, and saving it in the meantime drops the requirement silently.
--
-- "Once per database, at the moment the table appears" is what a migration IS.
-- Keeping it here means it runs inside this transaction, on every environment,
-- without anybody remembering a second command or putting a production
-- connection string on a laptop.

CREATE TABLE "CertificationType" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CertificationType_pkey" PRIMARY KEY ("id")
);

-- Case-SENSITIVE, which is what Postgres gives here. It stops the same entry
-- twice; it does not stop "Food Safety" beside "food safety". Eligibility
-- lower-cases before comparing, so those two would be one certificate wearing
-- two entries — `CertificationTypeService` enforces that rule, and this is the
-- backstop beneath it.
CREATE UNIQUE INDEX "CertificationType_organizationId_name_key" ON "CertificationType"("organizationId", "name");

CREATE INDEX "CertificationType_organizationId_idx" ON "CertificationType"("organizationId");

ALTER TABLE "CertificationType"
  ADD CONSTRAINT "CertificationType_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- >>> BACKFILL
--
-- Every certificate name already in use in each organisation, from BOTH places
-- it can live: the members' own records, and the requirements written onto
-- tasks. The second is the one that would cost data if it were missed.
--
-- `DISTINCT ON (organizationId, lower(name))` collapses two spellings of one
-- certificate into a single entry, keeping whichever sorts first. Eligibility
-- compares `trim().toLowerCase()` on both sides, so "Food Safety" and "food
-- safety" ARE one certificate — listing both would offer a manager two ways to
-- require the same thing, which is the ambiguity this table exists to remove.
--
-- `md5(random()::text || clock_timestamp()::text)` because `@default(cuid())`
-- is applied by the Prisma client, not by the database, so SQL has to supply
-- its own id. Nothing reads the format; it only has to be unique.
--
-- `ON CONFLICT DO NOTHING` because this file is not the only thing that writes
-- these rows: `db push` does not run migrations, so on a developer machine the
-- statement is applied by hand, and the demo seed derives the same list from
-- the same data. Any of those may already have run.
INSERT INTO "CertificationType" ("id", "organizationId", "name", "createdAt", "updatedAt")
SELECT DISTINCT ON ("organizationId", lower("name"))
       md5(random()::text || clock_timestamp()::text),
       "organizationId",
       "name",
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
FROM (
    SELECT m."organizationId", btrim(c."name") AS "name"
    FROM "Certification" c
    JOIN "Membership" m ON m."id" = c."membershipId"
  UNION ALL
    SELECT t."organizationId", btrim(r) AS "name"
    FROM "Task" t, unnest(t."requiredCertifications") AS r
) AS in_use
WHERE "name" <> ''
ORDER BY "organizationId", lower("name"), "name"
ON CONFLICT ("organizationId", "name") DO NOTHING;

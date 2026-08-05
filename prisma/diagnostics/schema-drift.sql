-- Which migrations does this database have?
--
--   psql "<url>" -f prisma/diagnostics/schema-drift.sql
--
-- Prints the database you are connected to, then one row per migration with
-- OK or MISSING.
--
-- ## Run it with psql, NOT `prisma db execute`
--
-- `prisma db execute` is for DDL. It reports "Script executed successfully" and
-- DISCARDS query results, so this file would look clean against a database
-- missing everything. Use psql, or paste the query into the Supabase SQL editor.
--
-- ## Why this exists rather than `prisma migrate status`
--
-- Migration history is not baselined on any of the three databases — none has a
-- `_prisma_migrations` table (claude/BACKLOG.md §5). So Prisma cannot say what
-- has been applied: `migrate status` reports everything as pending and
-- `migrate deploy` would try to replay all twenty against a database that
-- already has the schema. The only reliable question is whether the shape
-- matches, which is what this asks.
--
-- Covers 20260801 onward — the ones added since the last known-good hand-carry.
-- Earlier migrations are assumed applied because the app would be visibly
-- broken without them.

SELECT current_database() AS db, inet_server_port() AS port;

WITH expected(migration, tbl, col) AS (VALUES
  ('20260801 withdrawal notes','TaskAssignment','withdrawalNotes'),
  ('20260802 allocation provenance','TaskAssignment','allocationSource'),
  ('20260802 allocation provenance','TaskAssignment','allocationProvider'),
  ('20260802 allocation provenance','TaskAssignment','allocationScore'),
  ('20260802 allocation provenance','TaskAssignment','allocationRank'),
  ('20260803 seniority + feedback','Membership','seniorityOverride'),
  ('20260803 seniority + feedback','CompanySettings','experiencedShiftThreshold'),
  ('20260803 seniority + feedback','CompanySettings','seniorShiftThreshold'),
  ('20260803 seniority + feedback','Task','compositionRules'),
  ('20260803 seniority + feedback','TaskAssignment','acceptedAt'),
  ('20260803 seniority + feedback','TaskAssignment','rejectedAt'),
  ('20260803 seniority + feedback','TaskAssignment','withdrawalRequestedAt'),
  ('20260803 seniority + feedback','TaskAssignment','satisfactionRating'),
  ('20260803 seniority + feedback','TaskAssignment','satisfactionComment'),
  ('20260803 seniority + feedback','TaskAssignment','ratedAt')
)
SELECT migration,
       CASE WHEN count(*) FILTER (
         WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c
                           WHERE c.table_name = e.tbl AND c.column_name = e.col)
       ) = 0 THEN 'OK' ELSE 'MISSING - run it' END AS status
FROM expected e
GROUP BY migration

UNION ALL

SELECT '20260805 work rule restrict',
       CASE WHEN count(*) FILTER (WHERE confdeltype <> 'r') = 0
            THEN 'OK' ELSE 'MISSING - run it' END
FROM pg_constraint
WHERE conname IN ('WorkRule_roleId_fkey','WorkRule_departmentId_fkey')

ORDER BY 1;

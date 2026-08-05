-- Work-rule targets: SetNull → Restrict.
--
-- ## What was wrong
--
-- A work rule targets a department, a custom role, both, or NEITHER — and
-- "neither" is how a global rule is expressed. Both foreign keys were
-- ON DELETE SET NULL, so deleting the role or department a rule pointed at
-- blanked the reference and the rule silently became org-wide. "Trainees need
-- 11 hours off after a long shift" quietly turned into "everyone does", and
-- nothing in the data distinguished that from a rule somebody deliberately
-- made global.
--
-- The ambiguity is the fault: blank cannot mean both "I meant everyone" and
-- "my target was deleted". Restrict removes it at the source.
--
-- It failed in the safe direction — a widened rule refuses MORE rostering,
-- never less — but it surfaced as managers unable to roster people for reasons
-- that made no sense, with no trace of why.
--
-- ## Before running this against a live database
--
-- Restrict is a REAL constraint: after this, deleting a role or department that
-- work rules target fails at the database. `RoleService.delete` and
-- `DepartmentService.delete` check first and refuse with a message naming the
-- rules, so an admin meets a friendly error rather than a 500 — but that only
-- holds once the new application code is deployed. Run this WITH or AFTER the
-- code, never before.
--
-- Nothing is rewritten and no rows are touched: Postgres validates the existing
-- data against the new constraint and keeps the table in place. Existing rules
-- whose target was ALREADY nulled by the old behaviour are indistinguishable
-- from deliberate global rules and stay as they are — this stops the bug
-- recurring, it cannot recover intent that was already lost. Worth a look
-- before running:
--
--   SELECT "organizationId", name, type
--   FROM "WorkRule"
--   WHERE "roleId" IS NULL AND "departmentId" IS NULL;
--
-- Any rule there that was meant to be targeted needs re-pointing by hand.

-- ---------------------------------------------------------------------------
-- WorkRule.roleId
-- ---------------------------------------------------------------------------
ALTER TABLE "WorkRule" DROP CONSTRAINT IF EXISTS "WorkRule_roleId_fkey";
ALTER TABLE "WorkRule"
  ADD CONSTRAINT "WorkRule_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "Role"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- WorkRule.departmentId
-- ---------------------------------------------------------------------------
ALTER TABLE "WorkRule" DROP CONSTRAINT IF EXISTS "WorkRule_departmentId_fkey";
ALTER TABLE "WorkRule"
  ADD CONSTRAINT "WorkRule_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
